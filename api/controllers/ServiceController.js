const Boom = require('@hapi/boom');
const Mailchimp = require('mailchimp-api-v3');
const { google } = require('googleapis');
const ServiceCredentials = require('../models/ServiceCredentials');
const Service = require('../models/Service');
const User = require('../models/User');
const HelperService = require('../services/HelperService');
const NotificationService = require('../services/NotificationService');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
 * @module ServiceController
 * @description Controller for Services (Mailchimp, GGroup).
 */
module.exports = {

  async create(request) {
    request.payload.owner = request.auth.credentials._id;
    const service = await Service.create(request.payload);
    if (!service) {
      logger.warn(
        '[ServiceController->create] Could not create service',
        { request: request.payload },
      );
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

    if (request.params.id) {
      criteria._id = request.params.id;
      const result = await Service.findOne(criteria).populate(options.populate);
      if (!result) {
        logger.warn(
          `[ServiceController->find] Could not find service ${request.params.id}`,
        );
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
        logger.warn(
          '[ServiceController->find] Name of a service must have at least 3 characters in find method',
        );
        throw Boom.badRequest('Name must have at least 3 characters');
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
    logger.info(
      `[ServiceController->service] Updated service ${request.params.id}`,
      { request: request.payload },
    );
    return service;
  },

  async destroy(request, reply) {
    const criteria = {};
    criteria['subscriptions.service'] = request.params.id;
    const users = await User.find(criteria);
    const promises = [];
    const pendingLogs = [];
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
      pendingLogs.push({
        type: 'info',
        message: `[ServiceController->destroy] Successfully saved user ${user.id}`,
      });
    }
    await Promise.all(promises);
    // Possible performance impact by logging too much.
    for (let i = 0; i < pendingLogs.length; i += 1) {
      logger.log(pendingLogs[i]);
    }
    logger.info(
      `[ServiceController->destroy] Removed all user subscriptions for service ${request.params.id}`,
    );
    await Service.remove({ _id: request.params.id });
    logger.info(
      `[ServiceController->destroy] Removed service ${request.params.id}`,
    );
    return reply.response().code(204);
  },

  async mailchimpLists(request) {
    if (request.query.apiKey) {
      const mc = new Mailchimp(request.query.apiKey);
      const result = await mc.get({ path: '/lists' });
      logger.info(
        '[ServiceController->mailchimpLists] Retrieved mailchimp lists',
      );
      return result;
    }
    logger.warn(
      '[ServiceController->mailchimpLists] Missing Mailchimp API key',
    );
    throw Boom.badRequest();
  },

  // Get google groups from a domain
  async googleGroups(request) {
    // Find service credentials associated to domain
    const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': request.query.domain });
    if (!creds) {
      logger.warn(
        `[ServiceController->googleGroups] Could not find servicecredentials for domain ${request.query.domain}`,
      );
      throw Boom.badRequest();
    }
    const auth = Service.googleGroupsAuthorize(creds.googlegroup);
    const service = google.admin('directory_v1');
    const response = await service.groups.list({
      auth,
      customer: 'my_customer',
      maxResults: 200,
    });
    logger.info(
      `[ServiceController->googleGroups] Retrieved list of groups for domain ${request.query.domain}`,
    );
    return response.data.groups;
  },

  // Subscribe a user to a service
  async subscribe(request) {
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[ServiceController->subscribe] Could not find user ${request.params.id}`,
      );
      throw Boom.notFound();
    }
    if (user.subscriptionsIndex(request.payload.service) !== -1) {
      logger.warn(
        `[ServiceController->subscribe] User ${request.params.id} is already subscribed to ${request.payload.service}`,
      );
      throw Boom.badRequest('User is already subscribed');
    }
    if (user.emailIndex(request.payload.email) === -1) {
      logger.warn(
        `[ServiceController->subscribe] Wrong email ${request.payload.email} for user ${request.params.id}`,
      );
      throw Boom.badRequest('Wrong email');
    }
    const service = await Service.findOne({ _id: request.payload.service, deleted: false });
    if (!service) {
      logger.warn(
        `[ServiceController->subscribe] Could not find service ${request.payload.service}`,
      );
      throw Boom.badRequest();
    }
    if (service.type === 'googlegroup') {
      const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': service.googlegroup.domain });
      if (!creds) {
        logger.error(
          `[ServiceController->subscribe] Could not find service credentials for domain ${service.googlegroup.domain}`,
        );
        throw new Error('Could not find service credentials');
      }
      await service.subscribeGoogleGroup(user, request.payload.email, creds);
      logger.info(
        `[ServiceController->subscribe] Subscribed user ${request.params.id} to service ${request.payload.service}`,
      );
      user.subscriptions.push({ email: request.payload.email, service });
      await user.save();
      logger.info(
        `[ServiceController->subscribe] Saved user ${request.params.id}`,
      );
    }
    if (service.type === 'mailchimp') {
      try {
        const output = await service.subscribeMailchimp(user, request.payload.email);
        logger.info(
          `[ServiceController->subscribe] Subscribed user ${request.params.id} to service ${request.payload.service}`,
        );
        if (output.statusCode === 200) {
          user.subscriptions.push({ email: request.payload.email, service });
          await user.save();
          logger.info(
            `[ServiceController->subscribe] Saved user ${request.params.id}`,
          );
        } else {
          logger.error(
            '[ServiceController->subscribe] Error calling the Mailchimp API',
            { err: output },
          );
          throw new Error(output);
        }
      } catch (err) {
        if (err.title && err.title === 'Member Exists') {
          logger.info(
            `[ServiceController->subscribe] Email ${request.payload.email} is already part of mailchimp list associated to ${request.payload.service}`,
          );
          // Member already exists in mailchimp
          user.subscriptions.push({ email: request.payload.email, service });
          await user.save();
          logger.info(
            `[ServiceController->subscribe] Saved user ${request.params.id} with new mailchimp subscription`,
          );
          if (user.id !== request.auth.credentials.id) {
            const notification = {
              type: 'service_subscription',
              user,
              createdBy: request.auth.credentials,
              params: { service },
            };
            await NotificationService.send(notification);
            logger.info(
              `[ServiceController->subscribe] Sent a service_subscription notification to ${user.email}`,
            );
          }
        } else {
          logger.error(
            '[ServiceController->subscribe] Error calling Mailchimp API',
            {
              fail: true,
              error: err.message,
              stack_trace: err.stack,
              err_object: err,
            },
          );
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
      logger.info(
        `[ServiceController->subscribe] Sent a service_subscription notification to ${user.email}`,
      );
    }
    return user;
  },

  async unsubscribe(request) {
    let sendNotification = true;
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[ServiceController->unsubscribe] Could not find user ${request.params.id}`,
      );
      throw Boom.notFound();
    }
    if (user.subscriptionsIndex(request.params.serviceId) === -1) {
      logger.warn(
        `[ServiceController->unsubscribe] User ${request.params.id} is not subscribed to ${request.payload.service}`,
      );
      throw Boom.notFound();
    }
    const service = await Service.findOne({ _id: request.params.serviceId, deleted: false });
    if (!service) {
      logger.warn(
        `[ServiceController->unsubscribe] Could not find service ${request.payload.service}`,
      );
      throw Boom.badRequest();
    }
    const index = user.subscriptionsIndex(request.params.serviceId);
    if (service.type === 'googlegroup') {
      const creds = await ServiceCredentials.findOne({ type: 'googlegroup', 'googlegroup.domain': service.googlegroup.domain });
      if (!creds) {
        logger.error(
          `[ServiceController->unsubscribe] Could not find service credentials for domain ${service.googlegroup.domain}`,
        );
        throw new Error('Could not find service credentials');
      }
      try {
        await service.unsubscribeGoogleGroup(user, creds);
        logger.info(
          `[ServiceController->unsubscribe] Unsubscribed user ${request.params.id} from service ${request.payload.service}`,
        );
        user.subscriptions.splice(index, 1);
        await user.save();
      } catch (err) {
        if (err.status === 404) {
          logger.info(
            `[ServiceController->unsubscribe] User ${request.params.id} was not part of google group associated to service ${request.payload.service}`,
          );
          sendNotification = false;
          user.subscriptions.splice(index, 1);
          await user.save();
        } else {
          logger.error(
            '[ServiceController->unsubscribe] Error calling google groups API',
            {
              fail: true,
              error: err.message,
              err_object: err,
              stack_trace: err.stack,
            },
          );
          throw err;
        }
      }
    }
    if (service.type === 'mailchimp') {
      try {
        const output = await service.unsubscribeMailchimp(user);
        logger.info(
          `[ServiceController->unsubscribe] Unsubscribed user ${request.params.id} from service ${request.payload.service}`,
        );
        if (output.statusCode === 204) {
          logger.info(
            `[ServiceController->unsubscribe] User ${request.params.id} was successfully unsubscribed from mailchimp list associated to service ${request.payload.service}`,
          );
          user.subscriptions.splice(index, 1);
          await user.save();
        } else {
          logger.error(
            '[ServiceController->unsubscribe] Error calling Mailchimp API',
            { error: output },
          );
          throw new Error(output);
        }
      } catch (err) {
        if (err.status === 404) {
          logger.info(
            `[ServiceController->unsubscribe] User ${request.params.id} was not part of the Mailchimp list associated to service ${request.payload.service}`,
          );
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
      logger.info(
        `[ServiceController->unsubscribe] Sent a service_unsubscription notification to ${user.email}`,
      );
    }
    return user;
  },
};
