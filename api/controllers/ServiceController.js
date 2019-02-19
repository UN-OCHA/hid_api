

const Boom = require('boom');
const Mailchimp = require('mailchimp-api-v3');
const { google } = require('googleapis');
const ServiceCredentials = require('../models/ServiceCredentials');
const Service = require('../models/Service');
const User = require('../models/User');
const HelperService = require('../services/HelperService');
const NotificationService = require('../services/NotificationService');

/**
 * @module ServiceController
 * @description Controller for Services (Mailchimp, GGroup).
 */
module.exports = {

  async create(request) {
    request.payload.owner = request.auth.credentials._id;
    const service = await Service.create(request.payload);
    if (!service) {
      throw Boom.badRequest();
    }
    return service;
  },

  async find(request, reply) {
    const options = HelperService.getOptionsFromQuery(request.query);
    const criteria = HelperService.getCriteriaFromQuery(request.query);

    if (!request.auth.credentials.is_admin) {
      criteria.$or = [
        { hidden: false },
        { owner: request.auth.credentials._id },
        { managers: request.auth.credentials._id },
      ];
    }

    if (!options.populate) {
      options.populate = 'lists managers owner';
    }

    // Do not show deleted lists
    criteria.deleted = false;

    if (criteria.lists) {
      criteria.lists = { $in: criteria.lists.split(',') };
    }

    if (request.params.id) {
      criteria._id = request.params.id;
      const result = await Service.findOne(criteria).populate(options.populate);
      if (!result) {
        throw Boom.notFound();
      }

      result.sanitize(request.auth.credentials);
      return result;
    }

    if (criteria.lists) {
      const lists = criteria.lists.split(',');
      if (lists.length > 1) {
        criteria.$or = [];
        lists.forEach((id) => {
          criteria.$or.push({ lists: id });
        });
        delete criteria.lists;
      }
    }

    if (criteria.name) {
      if (criteria.name.length < 3) {
        return reply(Boom.badRequest('Name must have at least 3 characters'));
      }
      criteria.name = criteria.name.replace(/\(|\\|\^|\.|\||\?|\*|\+|\)|\[|\{|<|>|\/|"/, '-');
      criteria.name = new RegExp(criteria.name, 'i');
    }

    const [results, number] = await Promise.all([
      HelperService.find(Service, criteria, options),
      Service.countDocuments(criteria),
    ]);

    for (let i = 0; i < results.length; i += 1) {
      results[i].sanitize(request.auth.credentials);
    }
    return reply.response(results).header('X-Total-Count', number);
  },

  async update(request) {
    const service = await Service
      .findOneAndUpdate(
        { _id: request.params.id },
        request.payload,
        { runValidators: true, new: true },
      );
    return service;
  },

  async destroy(request, reply) {
    const criteria = {};
    criteria['subscriptions.service'] = request.params.id;
    const users = await User.find(criteria);
    const promises = [];
    for (let i = 0; i < users.length; i += 1) {
      const user = users[i];
      for (let j = user.subscriptions.length; j >= 0; j -= 1) {
        if (user.subscriptions[j]
          && user.subscriptions[j].service
          && user.subscriptions[j].service.toString() === request.params.id) {
          user.subscriptions.splice(j, 1);
        }
      }
      user.markModified('subscriptions');
      promises.push(user.save());
    }
    await Promise.all(promises);
    await Service.remove({ _id: request.params.id });
    return reply.response().code(204);
  },

  async mailchimpLists(request) {
    if (request.query.apiKey) {
      const mc = new Mailchimp(request.query.apiKey);
      const result = await mc.get({ path: '/lists' });
      return result;
    }
    throw Boom.badRequest();
  },

  // Get google groups from a domain
  async googleGroups(request) {
    // Find service credentials associated to domain
    const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': request.query.domain });
    if (!creds) {
      throw Boom.badRequest();
    }
    const auth = Service.googleGroupsAuthorize(creds.googlegroup);
    const service = google.admin('directory_v1');
    const response = await service.groups.list({
      auth,
      customer: 'my_customer',
      maxResults: 200,
    });
    return response.groups;
  },

  // Subscribe a user to a service
  async subscribe(request) {
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      throw Boom.notFound();
    }
    if (user.subscriptionsIndex(request.payload.service) !== -1) {
      throw Boom.badRequest('User is already subscribed');
    }
    if (user.emailIndex(request.payload.email) === -1) {
      throw Boom.badRequest('Wrong email');
    }
    const service = await Service.findOne({ _id: request.payload.service, deleted: false });
    if (!service) {
      throw Boom.badRequest();
    }
    if (service.type === 'googlegroup') {
      const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': service.googlegroup.domain });
      if (!creds) {
        throw new Error('Could not find service credentials');
      }
      await service.subscribeGoogleGroup(user, request.payload.email, creds);
      user.subscriptions.push({ email: request.payload.email, service });
      await user.save();
    }
    if (service.type === 'mailchimp') {
      try {
        const output = await service.subscribeMailchimp(user, request.payload.email);
        if (output.statusCode === 200) {
          user.subscriptions.push({ email: request.payload.email, service });
          await user.save();
        } else {
          throw new Error(output);
        }
      } catch (err) {
        if (err.title && err.title === 'Member Exists') {
          // Member already exists in mailchimp
          user.subscriptions.push({ email: request.payload.email, service });
          await user.save();
          if (user.id !== request.auth.credentials.id) {
            const notification = {
              type: 'service_subscription',
              user,
              createdBy: request.auth.credentials,
              params: { service },
            };
            await NotificationService.send(notification);
          }
        } else {
          throw err;
        }
      }
    }
    // Send notification to user that he was subscribed to a service
    if (user.id !== request.auth.credentials.id) {
      const notification = {
        type: 'service_subscription',
        user,
        createdBy: request.auth.credentials,
        params: { service },
      };
      await NotificationService.send(notification);
    }
    return user;
  },

  async unsubscribe(request) {
    let sendNotification = true;
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      throw Boom.notFound();
    }
    if (user.subscriptionsIndex(request.params.serviceId) === -1) {
      throw Boom.notFound();
    }
    const service = await Service.findOne({ _id: request.params.serviceId, deleted: false });
    if (!service) {
      throw Boom.badRequest();
    }
    const index = user.subscriptionsIndex(request.params.serviceId);
    if (service.type === 'googlegroup') {
      const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': service.googlegroup.domain });
      if (!creds) {
        throw new Error('Could not find service credentials');
      }
      try {
        await service.unsubscribeGoogleGroup(user, creds);
        user.subscriptions.splice(index, 1);
        await user.save();
      } catch (err) {
        if (err.status === 404) {
          sendNotification = false;
          user.subscriptions.splice(index, 1);
          await user.save();
        } else {
          throw err;
        }
      }
    }
    if (service.type === 'mailchimp') {
      try {
        const output = await service.unsubscribeMailchimp(user);
        if (output.statusCode === 204) {
          user.subscriptions.splice(index, 1);
          await user.save();
        } else {
          throw new Error(output);
        }
      } catch (err) {
        if (err.status === 404) {
          sendNotification = false;
          user.subscriptions.splice(index, 1);
          await user.save();
        } else {
          throw err;
        }
      }
    }

    // Send notification to user that he was subscribed to a service
    if (sendNotification && user.id !== request.auth.credentials.id) {
      const notification = {
        type: 'service_unsubscription',
        user,
        createdBy: request.auth.credentials,
        params: { service },
      };
      await NotificationService.send(notification);
    }
    return user;
  },
};
