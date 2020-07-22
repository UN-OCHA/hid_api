const Boom = require('@hapi/boom');
const qs = require('qs');
const ejs = require('ejs');
const axios = require('axios');
const moment = require('moment');
const acceptLanguage = require('accept-language');
const sharp = require('sharp');
const validator = require('validator');

const hidAccount = '5b2128e754a0d6046d6c69f2';
const List = require('../models/List');
const User = require('../models/User');
// const OutlookService = require('../services/OutlookService');
const EmailService = require('../services/EmailService');
const HelperService = require('../services/HelperService');
const NotificationService = require('../services/NotificationService');
const GSSSyncService = require('../services/GSSSyncService');
const AuthPolicy = require('../policies/AuthPolicy');
const ListUserController = require('./ListUserController');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
 * @module UserController
 * @description CRUD controller for users.
 */

/**
 * Exports users in PDF, using the PDF snap service.
 */
async function _pdfExport(users, number, lists, req, format) {
  const filters = [];
  if (Object.prototype.hasOwnProperty.call(req.query, 'name') && req.query.name.length) {
    filters.push(req.query.name);
  }
  if (Object.prototype.hasOwnProperty.call(req.query, 'verified') && req.query.verified) {
    filters.push('Verified User');
  }
  if (Object.prototype.hasOwnProperty.call(req.query, 'is_admin') && req.query.is_admin) {
    filters.push('Administrator');
  }
  lists.forEach((list, index) => {
    if (index > 0) {
      filters.push(list.name);
    }
  });

  const data = {
    lists,
    number,
    users,
    dateGenerated: moment().format('LL'),
    filters,
  };
  let template = 'templates/pdf/printList.html';
  if (format === 'meeting-compact') {
    template = 'templates/pdf/printMeetingCompact.html';
  } else if (format === 'meeting-comfortable') {
    template = 'templates/pdf/printMeetingComfortable.html';
  }
  const str = await ejs.renderFile(template, data, {});

  // Send the HTML to the wkhtmltopdf service to generate a PDF, and
  // return the output.
  const postData = qs.stringify({ html: str });
  const hostname = process.env.WKHTMLTOPDF_HOST;
  const port = process.env.WKHTMLTOPDF_PORT || 80;
  const params = {
    service: 'hid_api',
    pdfLandscape: true,
    pdfBackground: true,
    pdfMarginUnit: 'mm',
    pdfMarginTop: 10,
    pdfMarginBottom: 10,
    pdfMarginRight: 10,
    pdfMarginLeft: 10,
    scale: 1,
  };
  const clientRes = await axios({
    method: 'post',
    url: `http://${hostname}:${port}/snap`,
    params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': postData.length,
      'X-Forwarded-For': req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      'User-Agent': req.headers['user-agent'],
    },
    data: postData,
    responseType: 'arraybuffer',
  });
  if (clientRes && clientRes.status === 200) {
    // clientRes.setEncoding('binary');

    const pdfSize = parseInt(clientRes.headers['content-length'], 10);

    return [clientRes.data, pdfSize];
  }
  logger.error(
    '[UserController->_pdfExport] An error occurred while generating a PDF',
    {
      request: req,
      fail: true,
      response: clientRes,
    },
  );
  throw new Error(`An error occurred while generating PDF for list ${data.lists[0].name}`);
}

/**
 * Exports users to txt.
 */
function _txtExport(users) {
  let out = '';
  for (let i = 0; i < users.length; i += 1) {
    out += `${users[i].name} <${users[i].email}>;`;
  }
  return out;
}

/**
 * Get the list of bundles a user is checked into.
 */
function getBundles(user) {
  let bundles = '';
  user.bundles.forEach((bundle) => {
    if (!bundle.deleted) {
      bundles += `${bundle.name};`;
    }
  });
  return bundles;
}

/**
 * Get the list of functional roles a user is checked into.
 */
function getRoles(user) {
  let roles = '';
  user.functional_roles.forEach((role) => {
    if (!role.deleted) {
      roles += `${role.name};`;
    }
  });
  return roles;
}

/**
 * Helper function to export users to csv
 */
function _csvExport(users, full = false) {
  let out = 'Given Name,Family Name,Job Title,Organization,Groups,Roles,Country,Admin Area,Phone,Skype,Email,Notes\n';
  let org = '';
  let bundles = '';
  let roles = '';
  let country = '';
  let region = '';
  let jobTitle = '';
  let phoneNumber = '';
  let skype = '';
  let status = '';
  let orphan = '';
  let ghost = '';
  let verified = '';
  let manager = '';
  let admin = '';
  if (full) {
    out = 'Given Name,Family Name,Job Title,Organization,Groups,Roles,Country,Admin Area,Phone,Skype,Email,Notes,Created At,Updated At,Orphan,Ghost,Verified,Manager,Admin\n';
  }
  for (let i = 0; i < users.length; i += 1) {
    org = '';
    bundles = '';
    country = '';
    region = '';
    skype = '';
    roles = '';
    jobTitle = users[i].job_title || ' ';
    phoneNumber = users[i].phone_number || ' ';
    status = users[i].status || ' ';
    if (users[i].organization && users[i].organization.list) {
      org = users[i].organization.name;
    }
    if (users[i].bundles && users[i].bundles.length) {
      bundles = getBundles(users[i]);
    }
    if (users[i].functional_roles && users[i].functional_roles.length) {
      roles = getRoles(users[i]);
    }
    if (users[i].location && users[i].location.country) {
      country = users[i].location.country.name;
    }
    if (users[i].location && users[i].location.region) {
      region = users[i].location.region.name;
    }
    if (users[i].voips.length) {
      for (let j = 0; j < users[i].voips.length; j += 1) {
        if (users[i].voips[j].type === 'Skype') {
          skype = users[i].voips[j].username;
        }
      }
    }
    orphan = users[i].is_orphan ? '1' : '0';
    ghost = users[i].is_ghost ? '1' : '0';
    verified = users[i].verified ? '1' : '0';
    manager = users[i].isManager ? '1' : '0';
    admin = users[i].is_admin ? '1' : '0';
    out = `${out
    }"${users[i].given_name}",`
      + `"${users[i].family_name}",`
      + `"${jobTitle}",`
      + `"${org}",`
      + `"${bundles}",`
      + `"${roles}",`
      + `"${country}",`
      + `"${region}",`
      + `"${phoneNumber}",`
      + `"${skype}",`
      + `"${users[i].email}",`
      + `"${status}`;
    if (full) {
      out = `${out}",`
        + `"${users[i].createdAt}",`
        + `"${users[i].updatedAt}",`
        + `"${orphan}",`
        + `"${ghost}",`
        + `"${verified}",`
        + `"${manager}",`
        + `"${admin}"\n`;
    } else {
      out += '"\n';
    }
  }
  return out;
}

module.exports = {

  /*
   * @api [post] /user
   * tags:
   *   - user
   * summary: Create a new user
   * requestBody:
   *   description: Required parameters to create a user.
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           email:
   *             type: string
   *             required: true
   *           family_name:
   *             type: string
   *             required: true
   *           given_name:
   *             type: string
   *             required: true
   *           app_verify_url:
   *             type: string
   *             required: true
   *             description: >-
   *               Should correspond to the endpoint you are interacting with.
   *           password:
   *             type: string
   *             required: false
   *             description: >-
   *               See `/user/{id}/password` for password requirements.
   *           confirm_password:
   *             type: string
   *             required: false
   *             description: >-
   *               See `/user/{id}/password` for password requirements. This
   *               field is REQUIRED if `password` is sent in the payload.
   * responses:
   *   '200':
   *     description: User was successfully created
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request. Missing required parameters.
   *   '403':
   *     description: Forbidden. Your account is not allowed to create users.
   * security: []
   */
  async create(request) {
    if (!request.payload.app_verify_url) {
      logger.warn(
        '[UserController->create] Missing app_verify_url',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Missing app_verify_url');
    }

    const appVerifyUrl = request.payload.app_verify_url;
    if (!HelperService.isAuthorizedUrl(appVerifyUrl)) {
      if (request.payload && request.payload.password) {
        delete request.payload.password;
      }
      if (request.payload && request.payload.confirm_password) {
        delete request.payload.confirm_password;
      }

      logger.warn(
        `[UserController->create] app_verify_url ${appVerifyUrl} is not in authorizedDomains allowlist`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Invalid app_verify_url');
    }

    let record = null;
    if (request.payload.email) {
      record = await User.findOne({ 'emails.email': request.payload.email });
    }

    if (!record) {
      // Create user
      if (request.payload.email) {
        request.payload.emails = [];
        request.payload.emails.push({ type: 'Work', email: request.payload.email, validated: false });
      }

      // Business logic: is the new password strong enough?
      //
      // v2 and v3 have different requirements so we check the request path before
      // checking the password strength.
      const requestIsV3 = request.path.indexOf('api/v3') !== -1;
      if (request.payload.password && request.payload.confirm_password) {
        if (requestIsV3 && !User.isStrongPasswordV3(request.payload.password)) {
          logger.warn(
            '[UserController->create] Provided password is not strong enough (v3)',
            {
              request,
              security: true,
              fail: true,
            },
          );
          throw Boom.badRequest('The password is not strong enough');
        } else if (!User.isStrongPassword(request.payload.password)) {
          logger.warn(
            '[UserController->create] Provided password is not strong enough (v2)',
            {
              request,
              security: true,
              fail: true,
            },
          );
          throw Boom.badRequest('The password is not strong enough');
        }
        request.payload.password = User.hashPassword(request.payload.password);
      } else {
        // Set a random password
        request.payload.password = User.hashPassword(User.generateRandomPassword());
      }
      delete request.payload.app_verify_url;

      let notify = true;
      if (typeof request.payload.notify !== 'undefined') {
        const { notify: notif } = request.payload.notify;
        notify = notif;
      }
      delete request.payload.notify;

      let registrationType = '';
      if (request.payload.registration_type) {
        registrationType = request.payload.registration_type;
        delete request.payload.registration_type;
      }

      const childAttributes = User.listAttributes();
      HelperService.removeForbiddenAttributes(User, request, childAttributes);

      if (request.auth.credentials && registrationType === '') {
        // Creating an orphan user
        request.payload.createdBy = request.auth.credentials._id;
        // If an orphan is being created, do not expire
        request.payload.expires = new Date(0, 0, 1, 0, 0, 0);
        if (request.payload.email) {
          request.payload.is_orphan = true;
        } else {
          request.payload.is_ghost = true;
        }
      }

      // HID-1582: creating a short lived user for testing
      if (request.payload.tester) {
        const now = Date.now();
        request.payload.expires = new Date(now + 3600 * 1000);
        request.payload.email_verified = true;
        delete request.payload.tester;
      }

      const user = await User.create(request.payload);
      if (!user) {
        logger.warn(
          '[UserController->create] Create user failed',
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest();
      }
      logger.info(
        `[UserController->create] User created successfully with ID ${user._id.toString()}`,
        {
          request,
          security: true,
          user: {
            id: user._id.toString(),
            email: user.email,
            admin: user.is_admin,
          },
        },
      );

      if (user.email && notify === true) {
        if (!request.auth.credentials) {
          await EmailService.sendRegister(user, appVerifyUrl);
          logger.info(
            `[UserController->create] Sent registration email to ${user.email}`,
            {
              request,
            },
          );
        } else if (registrationType === 'kiosk') {
          // An admin is creating an orphan user or Kiosk registration
          await EmailService.sendRegisterKiosk(user, appVerifyUrl);
          logger.info(
            `[UserController->create] Sent registration kiosk email to ${user.email}`,
            {
              request,
            },
          );
        } else {
          await EmailService.sendRegisterOrphan(user, request.auth.credentials, appVerifyUrl);
          logger.info(
            `[UserController->create] Sent registration orphan email to ${user.email}`,
            {
              request,
            },
          );
        }
      }
      return user;
    }
    if (!request.auth.credentials) {
      logger.warn(
        `[UserController->create] The email address ${request.payload.email} is already registered`,
        {
          request,
          fail: true,
          user: {
            email: request.payload.email,
          },
        },
      );
      throw Boom.badRequest('This email address is already registered. If you can not remember your password, please reset it');
    } else {
      logger.warn(
        `[UserController->create] The user already exists with ID ${record._id.toString()}`,
        {
          request,
          fail: true,
          user: {
            id: record._id.toString(),
          },
        }
      );
      throw Boom.badRequest(`This user already exists. user_id=${record._id.toString()}`);
    }
  },

  /*
   * @api [get] /user/{id}
   * tags:
   *  - user
   * summary: Returns a User by ID.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   * responses:
   *   '200':
   *     description: The requested user
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Requesting user lacks permission to view requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async find(request, reply) {
    const reqLanguage = acceptLanguage.get(request.headers['accept-language']);

    if (request.params.id) {
      const criteria = { _id: request.params.id };
      if (!request.auth.credentials.verified) {
        criteria.is_orphan = false;
        criteria.is_ghost = false;
      }
      // Do not show user if it is hidden
      if (
        !request.auth.credentials.is_admin
        && request.auth.credentials._id
        && request.auth.credentials._id.toString() !== request.params.id
      ) {
        criteria.hidden = false;
      }
      const user = await User.findOne(criteria);
      if (!user) {
        logger.warn(
          `[UserController->find] Could not find user ${request.params.id}`,
        );
        throw Boom.notFound();
      } else {
        user.sanitize(request.auth.credentials);
        user.translateListNames(reqLanguage);
        return user;
      }

      // Finally: if we didn't find a user, send a 404.
      logger.warn(
        `[UserController->find] Could not find user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    const options = HelperService.getOptionsFromQuery(request.query);
    const criteria = HelperService.getCriteriaFromQuery(request.query);
    const childAttributes = User.listAttributes();

    // Hide hidden profile to non-admins
    if (request.auth.credentials && !request.auth.credentials.is_admin) {
      criteria.hidden = false;
    }

    // Do not allow exports for hidden users
    if (request.params.extension && request.auth.credentials.hidden) {
      logger.warn(
        `[UserController->find] Hidden user ${request.auth.credentials.id} tried to export users`,
        {
          request,
          fail: true,
          user: {
            id: request.auth.credentials.id,
          },
        },
      );
      throw Boom.unauthorized();
    }

    if (criteria.q) {
      if (validator.isEmail(criteria.q) && request.auth.credentials.verified) {
        criteria['emails.email'] = new RegExp(criteria.q, 'i');
      } else {
        criteria.name = criteria.q;
      }
      delete criteria.q;
    }

    if (criteria.name) {
      if (criteria.name.length < 3) {
        logger.warn(
          '[UserController->find] Name of a user must have at least 3 characters in find method',
          {
            request,
            fail: true,
          },
        );
        throw Boom.badRequest('Name must have at least 3 characters');
      }
      criteria.name = criteria.name.replace(/\(|\\|\^|\.|\||\?|\*|\+|\)|\[|\{|<|>|\/|"/g, '');
      criteria.name = new RegExp(criteria.name, 'i');
    }

    if (criteria.country) {
      criteria['location.country.id'] = criteria.country;
      delete criteria.country;
    }

    if (!request.auth.credentials.verified) {
      criteria.is_orphan = false;
      criteria.is_ghost = false;
    }
    const listIds = [];
    let lists = [];
    for (let i = 0; i < childAttributes.length; i += 1) {
      if (criteria[`${childAttributes[i]}.list`]) {
        listIds.push(criteria[`${childAttributes[i]}.list`]);
        delete criteria[`${childAttributes[i]}.list`];
      }
    }
    if (listIds.length) {
      lists = await List.find({ _id: { $in: listIds } });
      lists.forEach((list) => {
        if (list.isVisibleTo(request.auth.credentials)) {
          criteria[`${list.type}s`] = { $elemMatch: { list: list._id, deleted: false } };
          if (!list.isOwner(request.auth.credentials)) {
            criteria[`${list.type}s`].$elemMatch.pending = false;
          }
        } else {
          logger.warn(
            `[UserController->find] User ${request.auth.credentials.id} is not authorized to view list ${list._id.toString()}`,
            {
              request,
              fail: true,
            },
          );
          throw Boom.unauthorized('You are not authorized to view this list');
        }
      });
    }

    let pdfFormat = '';
    if (criteria.format) {
      pdfFormat = criteria.format;
      delete criteria.format;
    }
    const query = HelperService.find(User, criteria, options);
    if (criteria.name) {
      query.collation({ locale: 'en_US' });
    }
    // HID-1561 - Set export limit to 2000
    if (!options.limit && request.params.extension) {
      query.limit(100000);
    }
    if (request.params.extension) {
      query.select('name given_name family_name email job_title phone_number status organization bundles location voips connections phonesVisibility emailsVisibility locationsVisibility createdAt updatedAt is_orphan is_ghost verified isManager is_admin functional_roles');
      query.lean();
    }
    const [results, number] = await Promise.all([query, User.countDocuments(criteria)]);
    if (!results) {
      logger.warn(
        '[UserController->find] Could not find users',
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    if (request.params.extension) {
      // Sanitize users and translate list names from a plain object
      for (let i = 0, len = results.length; i < len; i += 1) {
        User.sanitizeExportedUser(results[i], request.auth.credentials);
        if (results[i].organization) {
          User.translateCheckin(results[i].organization, reqLanguage);
        }
      }
      if (request.params.extension === 'csv') {
        let csvExport = '';
        if (request.auth.credentials.is_admin) {
          csvExport = _csvExport(results, true);
        } else {
          csvExport = _csvExport(results, false);
        }
        return reply.response(csvExport)
          .type('text/csv')
          .header('Content-Disposition', `attachment; filename="Humanitarian ID Contacts ${moment().format('YYYYMMDD')}.csv"`);
      }
      if (request.params.extension === 'txt') {
        return reply.response(_txtExport(results))
          .type('text/plain');
      }
      if (request.params.extension === 'pdf') {
        const [buffer, bytes] = await _pdfExport(results, number, lists, request, pdfFormat);
        return reply.response(buffer)
          .type('application/pdf')
          .bytes(bytes)
          .header('Content-Disposition', `attachment; filename="Humanitarian ID Contacts ${moment().format('YYYYMMDD')}.pdf"`);
      }
    }
    for (let i = 0, len = results.length; i < len; i += 1) {
      results[i].sanitize(request.auth.credentials);
      results[i].translateListNames(reqLanguage);
    }
    return reply.response(results).header('X-Total-Count', number);
  },

  /*
   * @api [put] /user/{id}
   * tags:
   *   - user
   * summary: Update the user
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   * requestBody:
   *   description: The user object
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         $ref: '#/components/schemas/User'
   * responses:
   *   '200':
   *     description: The updated user object
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async update(request) {
    const childAttributes = User.listAttributes();
    HelperService.removeForbiddenAttributes(User, request, childAttributes);
    if (request.payload.password) {
      delete request.payload.password;
    }

    // Load the user based on ID from the HTTP request
    let user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        '[UserController->update] Could not find user',
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    // If verifying user, set verified_by and verificationExpiryEmail
    if (request.payload.verified && !user.verified) {
      request.payload.verified_by = request.auth.credentials._id;
      request.payload.verifiedOn = new Date();
      request.payload.verificationExpiryEmail = false;
    }

    if (request.payload.updatedAt) {
      delete request.payload.updatedAt;
    }

    // Update lastModified manually
    request.payload.lastModified = new Date();
    if (user.authOnly === false && request.payload.authOnly === true) {
      // User is becoming invisible. Update lists count.
      const listIds = user.getListIds(true);
      if (listIds.length) {
        await List.updateMany({ _id: { $in: listIds } }, {
          $inc: {
            countVerified: -1,
            countUnverified: -1,
          },
        });
        logger.info(
          '[UserController->update] User is becoming invisible. Updated list counts.',
          {
            request,
            user: {
              id: user._id.toString(),
            },
          },
        );
      }
    }

    if (user.authOnly === true && request.payload.authOnly === false) {
      // User is becoming visible. Update lists count.
      const listIds = user.getListIds(true);
      if (listIds.length) {
        await List.updateMany({ _id: { $in: listIds } }, {
          $inc: {
            countVerified: 1,
            countUnverified: 1,
          },
        });
        logger.info(
          '[UserController->update] User is becoming visible. Updated list counts',
          {
            request,
            user: {
              id: user._id.toString(),
            },
          },
        );
      }
    }

    if (user.hidden === false && request.payload.hidden === true) {
      // User is being flagged. Update lists count.
      const listIds = user.getListIds(true);
      if (listIds.length) {
        await List.updateMany({ _id: { $in: listIds } }, {
          $inc: {
            countManager: -1,
            countVerified: -1,
            countUnverified: -1,
          },
        });
        logger.info(
          '[UserController->update] User is being flagged. Updated list counts',
          {
            request,
            user: {
              id: user._id.toString(),
            },
          },
        );
      }
    }

    if (user.hidden === true && request.payload.hidden === false) {
      // User is being unflagged. Update lists count.
      const listIds = user.getListIds(true);
      if (listIds.length) {
        await List.updateMany({ _id: { $in: listIds } }, {
          $inc: {
            countManager: 1,
            countVerified: 1,
            countUnverified: 1,
          },
        });
        logger.info(
          '[UserController->update] User is being unflagged. Updated list counts',
          {
            request,
            user: {
              id: user._id.toString(),
            },
          },
        );
      }
    }

    user = await User.findOneAndUpdate(
      { _id: request.params.id },
      request.payload,
      { runValidators: true, new: true },
    );

    logger.info(
      '[UserController->update] Successfully saved user',
      {
        request,
        user: {
          id: user._id.toString(),
        },
      },
    );

    user = await user.defaultPopulate();
    const promises = [];
    if (request.auth.credentials._id.toString() !== user._id.toString()) {
      // User is being edited by someone else
      // If it's an auth account, surface it
      if (user.authOnly) {
        user.authOnly = false;
        // User is becoming visible. Update lists count.
        const listIds = user.getListIds(true);
        if (listIds.length) {
          promises.push(
            List.updateMany({ _id: { $in: listIds } }, {
              $inc: {
                countVerified: 1,
                countUnverified: 1,
              },
            }).then(() => {
              logger.info(
                '[UserController->update] User is becoming visible. Updated list counts',
                {
                  request,
                  user: {
                    id: user._id.toString(),
                  },
                },
              );
            }),
          );
        }
        promises.push(
          user.save().then(() => {
            logger.info(
              '[UserController->update] User saved successfully',
              {
                request,
                user: {
                  id: user._id.toString(),
                },
              },
            );
          }),
        );
        if (!user.hidden) {
          promises.push(
            EmailService.sendAuthToProfile(user, request.auth.credentials).then(() => {
              logger.info(
                '[UserController->update] Sent auth_to_profile email',
                {
                  request,
                  user: {
                    email: user.email,
                  },
                },
              );
            }),
          );
        }
      } else if (!user.hidden) {
        const notification = { type: 'admin_edit', user, createdBy: request.auth.credentials };
        promises.push(
          NotificationService.send(notification).then(() => {
            logger.info(
              '[UserController->update] Sent admin_edit notification',
              {
                request,
                user: {
                  id: user.id,
                },
              },
            );
          }),
        );
      }
    }

    promises.push(
      GSSSyncService.synchronizeUser(user).then(() => {
        logger.info(
          '[UserController->update] Synchronized user with google spreadsheet',
          {
            request,
            user: {
              id: user.id,
            },
          },
        );
      }),
    );

    // Execute all operations simultaneously
    await Promise.all(promises);

    return user;
  },

  /*
   * @api [delete] /user/{id}
   * tags:
   *   - user
   * summary: Delete the user.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * responses:
   *   '204':
   *     description: User deleted successfully.
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to delete requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async destroy(request, reply) {
    if (!request.auth.credentials.is_admin
      && request.auth.credentials._id.toString() !== request.params.id) {
      logger.warn(
        `[UserController->destroy] User ${request.auth.credentials._id.toString()} is not allowed to delete user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.forbidden('You are not allowed to delete this account');
    }

    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[UserController->destroy] Could not find user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    await EmailService.sendAdminDelete(user, request.auth.credentials);
    await user.remove();
    logger.info(
      `[UserController->destroy] Removed user ${request.params.id}`,
      {
        request,
      },
    );

    return reply.response().code(204);
  },

  /*
   * @api [put] /user/{id}/password
   * tags:
   *   - user
   * summary: Updates the password of a user.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * requestBody:
   *   description: >-
   *     The `new_password` must be different than `old_password` and meet ALL
   *     of the following requirements: at least 12 characters, one lowercase
   *     letter, one uppercase letter, one number, one special character
   *     ``!@#$%^&*()+=\`{}``
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           old_password:
   *             type: string
   *             required: true
   *           new_password:
   *             type: string
   *             required: true
   * responses:
   *   '204':
   *     description: Password updated successfully.
   *   '400':
   *     description: Bad request. Reason will be in response body.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async updatePassword(request, reply) {
    const user = await User.findOne({ _id: request.params.id });

    // Was the user parameter supplied?
    if (!user) {
      logger.warn(
        `[UserController->updatePassword] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    // Are both password parameters present?
    if (!request.payload.old_password || !request.payload.new_password) {
      logger.warn(
        `[UserController->updatePassword] Could not update user password for user ${user.id}. Request is missing parameters (old or new password)`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Request is missing parameters (old or new password)');
    }

    // Business logic: is the new password strong enough?
    //
    // v2 and v3 have different requirements so we check the request path before
    // checking the password strength.
    const requestIsV3 = request.path.indexOf('api/v3') !== -1;
    if (requestIsV3 && !User.isStrongPasswordV3(request.payload.new_password)) {
      logger.warn(
        `[UserController->updatePassword] Could not update user password for user ${user.id}. New password is not strong enough (v3)`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password does not meet requirements');
    } else if (!User.isStrongPassword(request.payload.new_password)) {
      logger.warn(
        `[UserController->updatePassword] Could not update user password for user ${user.id}. New password is not strong enough (v2)`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password is not strong enough');
    }

    // Was the current password entered correctly?
    if (user.validPassword(request.payload.old_password)) {
      // Business logic: is the new password different than the old one?
      if (request.payload.old_password === request.payload.new_password) {
        logger.warn(
          `[UserController->updatePassword] Could not update user password for user ${user.id}. New password is the same as old password.`,
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('New password must be different than previous password');
      }

      // Proceed with password update.
      user.password = User.hashPassword(request.payload.new_password);
      user.lastModified = new Date();
      await user.save();
      logger.info(
        `[UserController->updatePassword] Successfully updated password for user ${user._id.toString()}`,
        {
          request,
          security: true,
        },
      );
    } else {
      logger.warn(
        `[UserController->updatePassword] Could not update password for user ${user._id.toString()}. Old password is wrong.`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('The old password is wrong');
    }
    return reply.response().code(204);
  },

  /*
   * @TODO: refactor to include both params in route. See HID-2072.
   *
   * @api [put] /user/{id}/organization
   * tags:
   *   - user
   * summary: Set primary organization of the user.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   * requestBody:
   *   description: Organization to be marked primary.
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           _id:
   *             type: string
   *             required: true
   * responses:
   *   '200':
   *     description: The updated user object
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request. See response body for details.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async setPrimaryOrganization(request) {
    if (!request.payload) {
      logger.warn(
        '[UserController->setPrimaryOrganization] Missing request payload',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Missing listUser id');
    }
    if (!request.payload._id) {
      logger.warn(
        '[UserController->setPrimaryOrganization] Missing listUser id',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Missing listUser id');
    }

    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[UserController->setPrimaryOrganization] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    const checkin = user.organizations.id(request.payload._id);
    if (!checkin) {
      logger.warn(
        `[UserController->setPrimaryOrganization] Organization ${request.payload._id.toString()} should be part of user organizations`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Organization should be part of user organizations');
    }
    if (user.organization) {
      user.organization.set(checkin);
    } else {
      user.organization = checkin;
    }
    user.lastModified = new Date();
    await Promise.all([
      user.save(),
      GSSSyncService.synchronizeUser(user),
      // OutlookService.synchronizeUser(user),
    ]);
    logger.info(
      `[UserController->setPrimaryPhone] User ${request.params.id} saved successfully`,
      {
        request,
      },
    );
    logger.info(
      `[UserController->setPrimaryPhone] Successfully synchronized google spreadsheets for user ${request.params.id}`,
      {
        request,
      },
    );
    return user;
  },

  /*
   * @api [put] /user/{id}/email
   * tags:
   *   - user
   * summary: Sets the primary email of a user.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * requestBody:
   *   description: Email address to be marked primary.
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           email:
   *             type: string
   *             required: true
   * responses:
   *   '200':
   *     description: The updated user object
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async setPrimaryEmail(request) {
    const { email } = request.payload;

    if (!request.payload.email) {
      logger.warn(
        '[UserController->setPrimaryEmail] No email in payload',
        {
          request,
        },
      );
      throw Boom.badRequest();
    }

    const record = await User.findOne({ _id: request.params.id }).catch((err) => {
      logger.error(
        `[UserController->setPrimaryEmail] ${err.message}`,
        {
          request,
          security: true,
          fail: true,
          stack_trace: err.stack,
        },
      );

      throw Boom.internal('There is a problem querying to the database. Please try again.');
    });

    if (!record) {
      logger.warn(
        `[UserController->setPrimaryEmail] Could not find user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    // Make sure email is validated
    const index = record.emailIndex(email);
    if (index === -1) {
      logger.warn(
        `[UserController->setPrimaryEmail] Email ${email} does not exist for user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email does not exist');
    }
    if (!record.emails[index].validated) {
      logger.warn(
        `[UserController->setPrimaryEmail] Email ${record.emails[index]} has not been validated for user ${request.params.id}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email has not been validated. You need to validate it first.');
    }
    record.email = email;
    // If we are there, it means that the email has been validated,
    // so make sure email_verified is set to true.
    record.verifyEmail(email);
    record.lastModified = new Date();
    await record.save();
    logger.info(
      `[UserController->setPrimaryEmail] Saved user ${request.params.id} successfully`,
      {
        request,
        user: {
          id: request.params.id,
          email,
        }
      },
    );
    await GSSSyncService.synchronizeUser(record);
    logger.info(
      `[UserController->setPrimaryEmail] Synchronized user ${request.params.id} with google spreadsheets successfully`,
      {
        request,
        user: {
          id: request.params.id,
        },
      },
    );

    return record;
  },

  async claimEmail(request, reply) {
    const appResetUrl = request.payload.app_reset_url;
    const userId = request.params.id;

    if (!HelperService.isAuthorizedUrl(appResetUrl)) {
      logger.warn(
        `[UserController->claimEmail] app_reset_url ${appResetUrl} is not in authorizedDomains allowlist`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('app_reset_url is invalid');
    }

    const record = await User.findOne({ _id: userId });
    if (!record) {
      logger.warn(
        `[UserController->claimEmail] User ${userId} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    await EmailService.sendClaim(record, appResetUrl);
    return reply.response('Claim email sent successfully').code(202);
  },

  async updatePicture(request) {
    const userId = request.params.id;

    const data = request.payload;
    if (data.file) {
      const image = sharp(data.file);
      const record = await User.findOne({ _id: userId });
      if (!record) {
        logger.warn(
          `[UserController->updatePicture] User ${request.params.id} not found`,
          {
            request,
            fail: true,
          },
        );
        throw Boom.notFound();
      }
      const metadata = await image.metadata();
      if (metadata.format !== 'jpeg' && metadata.format !== 'png') {
        logger.warn(
          `[UserController->updatePicture] ${metadata.format} is not a valid image format`,
          {
            request,
            fail: true,
          },
        );
        throw Boom.badRequest('Invalid image format. Only jpeg and png are accepted');
      }
      let path = `${__dirname}/../../assets/pictures/${userId}.`;
      let ext = '';
      ext = metadata.format;
      path += ext;
      await image.resize(200, 200).toFile(path);
      record.picture = `${process.env.ROOT_URL}/assets/pictures/${userId}.${metadata.format}`;
      record.lastModified = new Date();
      await record.save();
      logger.info(
        `[UserController->updatePicture] Successfully updated picture for user ${record._id.toString()}`,
        {
          request,
          user: {
            id: record._id.toString(),
          },
        },
      );
      return record;
    }
    throw Boom.badRequest('No file found');
  },

  /*
   * @api [post] /user/{id}/emails
   * tags:
   *   - user
   * summary: Add a new email to the user's profile.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   * requestBody:
   *   description: Email address and validation URL.
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           email:
   *             type: string
   *             required: true
   *           app_validation_url:
   *             type: string
   *             required: true
   *             description: >-
   *               Should correspond to the endpoint you are interacting with.
   * responses:
   *   '200':
   *     description: The updated user object
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request. Reason will be in response body.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async addEmail(request) {
    const appValidationUrl = request.payload.app_validation_url;
    const userId = request.params.id;

    if (!appValidationUrl || !request.payload.email) {
      logger.warn(
        '[UserController->addEmail] No email or app_validation_url provided',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Required parameters not present in payload');
    }

    if (!HelperService.isAuthorizedUrl(appValidationUrl)) {
      logger.warn(
        `[UserController->addEmail] app_validation_url ${appValidationUrl} is not in authorizedDomains allowlist`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Invalid app_validation_url');
    }

    // Make sure email added is unique
    const erecord = await User.findOne({ 'emails.email': request.payload.email });
    if (erecord) {
      logger.warn(
        `[UserController->addEmail] Email ${request.payload.email} is not unique`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email is not unique');
    }
    const record = await User.findOne({ _id: userId });
    if (!record) {
      logger.warn(
        `[UserController->addEmail] User ${userId} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    const { email } = request.payload;
    if (record.emailIndex(email) !== -1) {
      logger.warn(
        `[UserController->addEmail] Email ${email} already exists`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email already exists');
    }
    if (record.emails.length === 0 && record.is_ghost) {
      // Turn ghost into orphan and set main email address
      record.is_ghost = false;
      record.is_orphan = true;
      record.email = request.payload.email;
    }
    const data = { email: request.payload.email, type: request.payload.type, validated: false };
    record.emails.push(data);
    record.lastModified = new Date();
    const savedRecord = await record.save();
    logger.warn(
      `[UserController->addEmail] Successfully saved user ${record.id}`,
      {
        request,
        user: {
          id: record.id,
        },
      },
    );
    const savedEmailIndex = savedRecord.emailIndex(email);
    const savedEmail = savedRecord.emails[savedEmailIndex];
    // Send confirmation email
    const promises = [];
    promises.push(
      EmailService.sendValidationEmail(
        record,
        email,
        savedEmail._id.toString(),
        appValidationUrl,
      ).then(() => {
        logger.info(
          `[UserController->addEmail] Successfully sent validation email to ${email}`,
          {
            request,
            user: {
              email,
            },
          },
        );
      })
    );
    for (let i = 0; i < record.emails.length; i += 1) {
      promises.push(
        EmailService.sendEmailAlert(record, record.emails[i].email, request.payload.email).then(() => {
          logger.info(
            `[UserController->addEmail] Successfully sent email alert to ${record.emails[i].email}`,
            {
              request,
              user: {
                email: record.emails[i].email,
              },
            },
          );
        })
      );
    }

    await Promise.all(promises);
    return record;
  },

  /*
   * @api [delete] /user/{id}/emails/{email}
   * tags:
   *   - user
   * summary: Remove an email address from the user's profile.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric User ID
   *     in: path
   *     required: true
   *     default: ''
   *   - name: email
   *     description: An email address from the user's profile.
   *     in: path
   *     required: true
   *     default: ''
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * responses:
   *   '200':
   *     description: The updated user object
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request. Reason will be in response body.
   *   '401':
   *     description: Unauthorized.
   *   '403':
   *     description: Requesting user lacks permission to update requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async dropEmail(request) {
    const { id, email } = request.params;

    if (!request.params.email) {
      logger.warn(
        '[UserController->dropEmail] No email provided',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest();
    }

    const record = await User.findOne({ _id: id });
    if (!record) {
      logger.warn(
        `[UserController->dropEmail] User ${id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    if (email === record.email) {
      logger.warn(
        `[UserController->dropEmail] Primary email for user ${id} can not be removed`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('You can not remove the primary email');
    }
    const index = record.emailIndex(email);
    if (index === -1) {
      logger.warn(
        `[UserController->dropEmail] Email ${email} does not exist`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email does not exist');
    }
    record.emails.splice(index, 1);
    record.lastModified = new Date();
    const stillVerified = await record.canBeVerifiedAutomatically();
    if (!stillVerified) {
      record.verified = false;
    }
    await record.save();

    logger.info(
      `[UserController->dropEmail] User ${id} saved successfully`,
      {
        request,
        user: {
          id,
        },
      },
    );

    return record;
  },

  /*
   * @TODO: This function does two different tasks based on the input received,
   *        but our docs tool cannot branch response codes based on input. We
   *        will split the function into two separate methods which will both
   *        simplify the code and make accurate docs possible.
   *
   * @see HID-2064
   *
   * @api [put] /user/emails/{email}
   * tags:
   *   - user
   * summary: >-
   *   Sends confirmation email, or confirms ownership of an email address.
   * parameters:
   *   - name: email
   *     description: The email address to confirm.
   *     in: path
   *     required: true
   *     default: ''
   * requestBody:
   *   description: Required parameters to validate an email address.
   *   required: false
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           app_validation_url:
   *             type: string
   *             required: true
   * responses:
   *   '204':
   *     description: Email sent successfully.
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Unauthorized.
   *   '404':
   *     description: Requested email address not found.
   * security: []
   */
  async validateEmail(request) {
    // TODO: make sure current user can do this

    if (request.payload.hash) {
      const record = await User.findOne({ _id: request.payload.id }).catch((err) => {
        logger.error(
          `[UserController->validateEmail] ${err.message}`,
          {
            request,
            security: true,
            fail: true,
            stack_trace: err.stack,
          },
        );

        throw Boom.internal('There is a problem querying to the database. Please try again.');
      });

      if (!record) {
        logger.warn(
          `[UserController->validateEmail] Could not find user ${request.payload.id}`,
          {
            request,
            fail: true,
          },
        );
        throw Boom.notFound();
      }
      let domain = null;
      let { email } = record;
      if (request.payload.emailId) {
        const emailRecord = record.emails.id(request.payload.emailId);
        if (emailRecord) {
          ({ email } = emailRecord);
        }
      }
      // Verify hash
      if (record.validHash(request.payload.hash, 'verify_email', request.payload.time, email) === true) {
        // Verify user email
        if (record.email === email) {
          record.email_verified = true;
          record.expires = new Date(0, 0, 1, 0, 0, 0);
          record.emails[0].validated = true;
          record.emails.set(0, record.emails[0]);
          record.lastModified = new Date();
          domain = await record.isVerifiableEmail(email);
        } else {
          for (let i = 0, len = record.emails.length; i < len; i += 1) {
            if (record.emails[i].email === email) {
              record.emails[i].validated = true;
              record.emails.set(i, record.emails[i]);
            }
          }
          record.lastModified = new Date();
          domain = await record.isVerifiableEmail(email);
        }
      } else {
        logger.warn(
          `[UserController->validateEmail] Invalid hash ${request.payload.hash} provided`,
          {
            request,
            fail: true,
          },
        );
        throw Boom.badRequest('Invalid hash');
      }
      if (domain) {
        record.verified = true;
        record.verified_by = hidAccount;
        record.verifiedOn = new Date();
        record.verificationExpiryEmail = false;
        // If the domain is associated to a list, check user in this list automatically
        if (domain.list) {
          if (!record.organizations) {
            record.organizations = [];
          }

          let isCheckedIn = false;
          // Make sure user is not already checked in this list
          for (let i = 0, len = record.organizations.length; i < len; i += 1) {
            if (record.organizations[i].list.equals(domain.list._id)
              && record.organizations[i].deleted === false) {
              isCheckedIn = true;
            }
          }

          if (!isCheckedIn) {
            await ListUserController.checkinHelper(domain.list, record, true, 'organizations', record);
          }
        }
      }
      const promises = [];
      promises.push(record.save().then(() => {
        logger.info(
          `[UserController->validateEmail] Saved user ${record.id} successfully`,
          {
            request,
            user: {
              id: record.id,
            },
          },
        );
      }));
      if (record.email === email) {
        promises.push(EmailService.sendPostRegister(record).then(() => {
          logger.info(
            `[UserController->validateEmail] Sent post_register email to ${record.email} successfully`,
            {
              request,
              user: {
                email: record.email,
              },
            },
          );
        }));
      }

      await Promise.all(promises);
      return record;
    }

    // When hash wasn't present, do this stuff instead.
    //
    // @TODO: split this into its own function.
    //
    // @see HID-2064
    const record = await User.findOne({ 'emails.email': request.params.email });
    if (!record) {
      logger.warn(
        `[UserController->validateEmail] Could not find user with email ${request.params.email}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    // Send validation email again
    const appValidationUrl = request.payload.app_validation_url;
    if (!HelperService.isAuthorizedUrl(appValidationUrl)) {
      logger.warn(
        `[UserController->validateEmail] app_validation_url ${appValidationUrl} is not in authorizedDomains allowlist`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Invalid app_validation_url');
    }
    const emailIndex = record.emailIndex(request.params.email);
    const email = record.emails[emailIndex];
    await EmailService.sendValidationEmail(
      record,
      email.email,
      email._id.toString(),
      appValidationUrl,
    );

    // v3: Send a 204 (empty body)
    const requestIsV3 = request.path.indexOf('api/v3') !== -1;
    if (requestIsV3) {
      return reply.response().code(204);
    }
    // v2: Send 200 with this response body.
    return 'Validation email sent successfully';
  },

  async addPhone(request) {
    const userId = request.params.id;

    const record = await User.findOne({ _id: userId });
    if (!record) {
      logger.warn(
        `[UserController->addPhone] User ${userId} not found`,
      );
      throw Boom.notFound();
    }
    const data = { number: request.payload.number, type: request.payload.type };
    record.phone_numbers.push(data);
    record.lastModified = new Date();
    await record.save();
    logger.info(
      `[UserController->addPhone] User ${userId} saved successfully`,
    );
    // await Promise.all([
    //  record.save(),
    //  OutlookService.synchronizeUser(record),
    // ]);
    return record;
  },

  async dropPhone(request) {
    const userId = request.params.id;
    const phoneId = request.params.pid;

    const record = await User.findOne({ _id: userId });
    if (!record) {
      logger.warn(
        `[UserController->dropPhone] User ${userId} not found`,
      );
      throw Boom.notFound();
    }
    let index = -1;
    for (let i = 0, len = record.phone_numbers.length; i < len; i += 1) {
      if (record.phone_numbers[i]._id.toString() === phoneId) {
        index = i;
      }
    }
    if (index === -1) {
      logger.warn(
        `[UserController->dropPhone] Phone number ${phoneId} not found for user ${userId}`,
      );
      throw Boom.notFound();
    }
    // Do not allow deletion of primary phone number
    if (record.phone_numbers[index].number === record.phone_number) {
      record.phone_number = '';
      record.phone_number_type = '';
    }
    record.phone_numbers.splice(index, 1);
    record.lastModified = new Date();
    await record.save();
    logger.info(
      `[UserController->dropPhone] User ${record.id} saved successfully`,
    );
    // await Promise.all([
    //  record.save(),
    //  OutlookService.synchronizeUser(record),
    // ]);
    return record;
  },

  async setPrimaryPhone(request) {
    const { phone } = request.payload;

    if (!request.payload.phone) {
      logger.warn(
        '[UserController->setPrimaryPhone] No phone in request payload',
      );
      throw Boom.badRequest();
    }
    const record = await User.findOne({ _id: request.params.id });
    if (!record) {
      logger.warn(
        `[UserController->setPrimaryPhone] User ${request.params.id} not found`,
      );
      throw Boom.notFound();
    }
    // Make sure phone is part of phone_numbers
    let index = -1;
    for (let i = 0, len = record.phone_numbers.length; i < len; i += 1) {
      if (record.phone_numbers[i].number === phone) {
        index = i;
      }
    }
    if (index === -1) {
      logger.warn(
        `[UserController->setPrimaryPhone] Phone number ${phone} not found for user ${request.params.id}`,
      );
      throw Boom.badRequest('Phone does not exist');
    }
    record.phone_number = record.phone_numbers[index].number;
    record.phone_number_type = record.phone_numbers[index].type;
    record.lastModified = new Date();
    await Promise.all([
      record.save(),
      GSSSyncService.synchronizeUser(record),
      // OutlookService.synchronizeUser(record),
    ]);
    logger.info(
      `[UserController->setPrimaryPhone] User ${request.params.id} saved successfully`,
    );
    logger.info(
      `[UserController->setPrimaryPhone] Successfully synchronized google spreadsheets for user ${request.params.id}`,
    );
    return record;
  },

  /*
   * @TODO: This function also needs to be split into two methods because it
   *        serves two purposes.
   *
   * @see HID-2067
   *
   * @api [put] /user/password
   * tags:
   *   - user
   * summary: Resets a user password or sends a password reset email.
   * parameters:
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * requestBody:
   *   description: >-
   *     Send a payload with `email` and `app_reset_url` to have this method
   *     send an email with a password recovery email. Send `id`,`time`,`hash`,
   *     `password` in the payload to have it reset the password. For password
   *     complexity requirements see `PUT /user/{id}/password`
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         type: object
   *         properties:
   *           email:
   *             type: string
   *             required: true
   *           app_reset_url:
   *             type: string
   *             required: true
   *             description: >-
   *               Should correspond to the endpoint you are interacting with.
   *           id:
   *             type: string
   *             required: true
   *           time:
   *             type: string
   *             required: true
   *           hash:
   *             type: string
   *             required: true
   *           password:
   *             type: string
   *             required: true
   * responses:
   *   '200':
   *     description: Password reset successfully.
   *   '400':
   *     description: Bad request. See response body for details.
   * security: []
   */
  async resetPasswordEndpoint(request) {
    if (request.payload.email) {
      const appResetUrl = request.payload.app_reset_url;

      if (!HelperService.isAuthorizedUrl(appResetUrl)) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] app_reset_url ${appResetUrl} is not in authorizedDomains allowlist`,
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('app_reset_url is invalid');
      }
      const record = await User.findOne({ email: request.payload.email.toLowerCase() });
      if (!record) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] User ${request.params.id} not found`,
          {
            request,
            fail: true,
          },
        );
        return '';
      }
      await EmailService.sendResetPassword(record, appResetUrl);
      logger.info(
        `[UserController->resetPasswordEndpoint] Successfully sent reset password email to ${record.email}`,
        {
          request,
          security: true,
        },
      );
      return '';
    }
    const cookie = request.yar.get('session');
    if (!request.payload.hash || !request.payload.password
      || !request.payload.id || !request.payload.time) {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Wrong or missing arguments',
        {
          request,
          security: true,
        },
      );
      throw Boom.badRequest('Wrong arguments');
    }

    // Business logic: is the new password strong enough?
    //
    // v2 and v3 have different requirements so we check the request path before
    // checking the password strength.
    const requestIsV3 = request.path.indexOf('api/v3') !== -1;
    if (requestIsV3 && !User.isStrongPasswordV3(request.payload.password)) {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Could not reset password. New password is not strong enough (v3)',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password is not strong enough');
    } else if (!User.isStrongPassword(request.payload.password)) {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Could not reset password. New password is not strong enough (v2)',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password is not strong enough');
    }

    let record = await User.findOne({ _id: request.payload.id });
    if (!record) {
      logger.warn(
        `[UserController->resetPasswordEndpoint] Could not reset password. User ${request.payload.id} not found`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Reset password link is expired or invalid');
    }
    if (record.totp && !cookie) {
      // Check that there is a TOTP token and that it is valid
      const token = request.headers['x-hid-totp'];
      record = await AuthPolicy.isTOTPValid(record, token);
    }
    let domain = null;
    if (record.validHash(request.payload.hash, 'reset_password', request.payload.time) === true) {
      // Check the new password against the old one.
      if (record.validPassword(request.payload.password)) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] Could not reset password for user ${request.payload.id}. The new password can not be the same as the old one`,
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('Could not reset password');
      } else {
        record.password = User.hashPassword(request.payload.password);
        record.verifyEmail(record.email);
        domain = await record.isVerifiableEmail(record.email);
      }
    } else {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Reset password link is expired or invalid',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Reset password link is expired or invalid');
    }
    if (domain) {
      // Reset verifiedOn date as user was able to
      // reset his password via an email from a trusted domain
      record.verified = true;
      record.verified_by = hidAccount;
      record.verifiedOn = new Date();
      record.verificationExpiryEmail = false;
    }
    record.expires = new Date(0, 0, 1, 0, 0, 0);
    if (record.is_orphan === true || record.is_ghost === true) {
      // User is not an orphan anymore. Update lists count.
      const listIds = record.getListIds(true);
      if (listIds.length) {
        await List.updateMany({ _id: { $in: listIds } }, { $inc: { countUnverified: 1 } });
        logger.info(
          `[UserController->resetPasswordEndpoint] User ${record._id.toString()} is not an orphan anymore. Updated list counts`,
          {
            request,
          },
        );
      }
    }
    record.is_orphan = false;
    record.is_ghost = false;
    record.lastPasswordReset = new Date();
    record.passwordResetAlert30days = false;
    record.passwordResetAlert7days = false;
    record.passwordResetAlert = false;
    record.lastModified = new Date();
    await record.save();
    logger.info(
      `[UserController->resetPasswordEndpoint] Password updated successfully for user ${record._id.toString()}`,
      {
        request,
        security: true,
      },
    );
    return 'Password reset successfully';
  },

  showAccount(request) {
    logger.info(
      `[UserController->showAccount] calling /account.json for ${request.auth.credentials.email}`,
      {
        request,
        user: {
          id: request.auth.credentials.id,
          email: request.auth.credentials.email,
          admin: request.auth.credentials.is_admin,
        },
      },
    );
    const user = JSON.parse(JSON.stringify(request.auth.credentials));
    if (request.params.currentClient && (request.params.currentClient.id === 'iasc-prod' || request.params.currentClient.id === 'iasc-dev')) {
      user.sub = user.email;
    }
    if (request.params.currentClient && request.params.currentClient.id === 'dart-prod') {
      delete user._id;
    }
    if (request.params.currentClient && request.params.currentClient.id === 'kaya-prod') {
      user.name = user.name.replace(' ', '');
    }
    if (request.params.currentClient
      && (request.params.currentClient.id === 'rc-shelter-database'
        || request.params.currentClient.id === 'rc-shelter-db-2-prod'
        || request.params.currentClient.id === 'deep-prod')) {
      user.active = !user.deleted;
    }
    return user;
  },

  async notify(request) {
    const record = await User.findOne({ _id: request.params.id });
    if (!record) {
      logger.warn(
        `[UserController->notify] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    const notPayload = {
      type: 'contact_needs_update',
      createdBy: request.auth.credentials,
      user: record,
    };
    await NotificationService.send(notPayload);
    logger.info(
      `[UserController->notify] Successfully sent contact_needs_update notification to ${record.email}`,
      {
        request,
      },
    );

    return record;
  },

  async addConnection(request) {
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[UserController->addConnection] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    if (!user.connections) {
      user.connections = [];
    }
    if (user.connectionsIndex(request.auth.credentials._id) !== -1) {
      logger.warn(
        `[UserController->addConnection] User ${request.params.id} is already a connection of ${request.auth.credentials._id.toString()}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('User is already a connection');
    }

    user.connections.push({ pending: true, user: request.auth.credentials._id });
    user.lastModified = new Date();

    const notification = {
      type: 'connection_request',
      createdBy: request.auth.credentials,
      user,
    };
    await Promise.all([
      user.save().then(() => {
        logger.info(
          `[UserController->addConnection] User ${request.params.id} successfully saved`,
          {
            request,
            user: {
              id: request.params.id,
            },
          },
        );
      }),
      NotificationService.send(notification).then(() => {
        logger.info(
          `[UserController->addConnection] Successfully sent connection_request notification to ${user.email}`,
          {
            request,
            user: {
              email: user.email,
            },
          },
        );
      }),
    ]);

    return user;
  },

  async updateConnection(request) {
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[UserController->updateConnection] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    const connection = user.connections.id(request.params.cid);
    connection.pending = false;
    user.lastModified = new Date();
    await user.save();
    logger.info(
      `[UserController->updateConnection] User ${request.params.id} added connection to ${request.params.cid}`,
      {
        request,
        user: {
          id: request.params.id,
          connection: request.params.cid,
        },
      },
    );
    const cuser = await User.findOne({ _id: connection.user });
    // Create connection with current user
    const cindex = cuser.connectionsIndex(user._id);
    if (cindex === -1) {
      cuser.connections.push({ pending: false, user: user._id });
    } else {
      cuser.connections[cindex].pending = false;
    }
    cuser.lastModified = new Date();
    await cuser.save();
    logger.info(
      `[UserController->updateConnection] User ${cuser.id} added connection to ${user.id}`,
      {
        request,
        user: {
          id: cuser.id,
          connection: user.id,
        },
      },
    );
    // Send notification
    const notification = {
      type: 'connection_approved',
      createdBy: user,
      user: cuser,
    };
    await NotificationService.send(notification).then(() => {
      logger.info(
        `[UserController->updateConnection] Successfully sent connection_approved notification to ${cuser.email}`,
        {
          request,
        },
      );
    });
    return user;
  },

  async deleteConnection(request) {
    const user = await User.findOne({ _id: request.params.id });
    if (!user) {
      logger.warn(
        `[UserController->deleteConnection] User ${request.params.id} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }
    user.connections.id(request.params.cid).remove();
    user.lastModified = new Date();
    await user.save();
    logger.info(
      `[UserController->deleteConnection] User ${request.params.id} removed ${request.params.cid} from connections.`,
      {
        request,
        user: {
          id: request.params.id,
          connection: request.params.cid,
        },
      },
    );
    return user;
  },
};
