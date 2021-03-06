/**
 * @module UserController
 * @description CRUD controller for users.
 */
const Boom = require('@hapi/boom');
const validator = require('validator');
const User = require('../models/User');
const EmailService = require('../services/EmailService');
const HelperService = require('../services/HelperService');
const AuthPolicy = require('../policies/AuthPolicy');
const config = require('../../config/env');

const { logger } = config;


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
        `[UserController->create] app_verify_url ${appVerifyUrl} is not in allowedDomains list`,
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

      if (request.payload.password && request.payload.confirm_password) {
        if (request.payload.password !== request.payload.confirm_password) {
          logger.warn(
            '[UserController->create] Passwords did not match during registration.',
            {
              request,
              security: true,
              fail: true,
            },
          );
          throw Boom.badRequest('The passwords do not match');
        }

        if (User.isStrongPassword(request.payload.password)) {
          request.payload.password = User.hashPassword(request.payload.password);
        } else {
          logger.warn(
            '[UserController->create] Provided password is not strong enough.',
            {
              request,
              security: true,
              fail: true,
            },
          );
          throw Boom.badRequest('The password is not strong enough');
        }
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

      HelperService.removeForbiddenAttributes(User, request, []);

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
        } else if (registrationType === 'kiosk') {
          // Kiosk registration
          await EmailService.sendRegisterKiosk(user, appVerifyUrl);
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
        },
      );
      throw Boom.badRequest(`This user already exists. user_id=${record._id.toString()}`);
    }
  },

  /*
   * @api [get] /user
   * tags:
   *  - user
   * summary: Returns a list of Users
   * responses:
   *   '200':
   *     description: An array of zero or more users.
   *     content:
   *       application/json:
   *         schema:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/User'
   *   '400':
   *     description: Bad request.
   *   '401':
   *     description: Requesting user lacks permission to query users.
   */

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
    if (request.params.id) {
      const criteria = { _id: request.params.id };

      // Do not show user if it is hidden
      if (
        !request.auth.credentials.is_admin
        && request.auth.credentials._id
        && request.auth.credentials._id.toString() !== request.params.id
      ) {
        criteria.hidden = false;
      }
      const user = await User.findOne(criteria);

      // If we found a user, return it
      if (user) {
        user.sanitize(request.auth.credentials);

        logger.info(
          '[UserController->find] Displaying one user by ID',
          {
            user: {
              id: user.id,
              email: user.email,
            },
          },
        );

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

    //
    // No ID was sent so we are returning a list of users.
    //
    const options = HelperService.getOptionsFromQuery(request.query);
    const criteria = HelperService.getCriteriaFromQuery(request.query);

    // Hide hidden profile to non-admins
    if (request.auth.credentials && !request.auth.credentials.is_admin) {
      criteria.hidden = false;
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

    const query = HelperService.find(User, criteria, options);
    if (criteria.name) {
      query.collation({ locale: 'en_US' });
    }
    // HID-1561 - Set export limit to 2000
    if (!options.limit && request.params.extension) {
      query.limit(100000);
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
    for (let i = 0, len = results.length; i < len; i += 1) {
      results[i].sanitize(request.auth.credentials);
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
    const childAttributes = [];
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

    // Don't keep old values for updatedAt from payload
    if (request.payload.updatedAt) {
      delete request.payload.updatedAt;
    }

    // Update lastModified manually
    request.payload.lastModified = new Date();

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
    // Don't allow admins to delete their account.
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

    // Find user in DB.
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

    // Delete this user.
    await user.remove();

    logger.info(
      `[UserController->destroy] Removed user ${request.params.id}`,
      {
        request,
        security: true,
      },
    );

    return reply.response().code(204);
  },

  /*
   * @api [post] /user/{id}/password
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
  async updatePassword(request, reply, internalArgs) {
    let userId;
    let oldPassword;
    let newPassword;

    if (internalArgs) {
      userId = internalArgs.userId;
      oldPassword = internalArgs.old_password;
      newPassword = internalArgs.new_password;
    } else {
      userId = request.params.id;
      oldPassword = request.payload.old_password;
      newPassword = request.payload.new_password;
    }

    // Look up user in DB.
    const user = await User.findOne({ _id: userId });

    // Was the user parameter supplied?
    if (!user) {
      logger.warn(
        `[UserController->updatePassword] User ${userId} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    // Are both password parameters present?
    if (!oldPassword || !newPassword) {
      logger.warn(
        `[UserController->updatePassword] Could not update user password for user ${userId}. Request is missing parameters (old_password or new_password)`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Request is missing parameters (old_password or new_password)');
    }

    // Business logic: is the new password strong enough?
    if (!User.isStrongPassword(newPassword)) {
      logger.warn(
        `[UserController->updatePassword] Could not update user password for user ${userId}. New password is not strong enough.`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password does not meet requirements');
    }

    // Was the current password entered correctly?
    if (user.validPassword(oldPassword)) {
      // Business logic: is the new password different than the old one?
      if (oldPassword === newPassword) {
        logger.warn(
          `[UserController->updatePassword] Could not update user password for user ${userId}. New password is the same as old password.`,
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('New password must be different than previous password');
      }

      // Proceed with password update.
      user.password = User.hashPassword(newPassword);
      user.lastModified = new Date();
      await user.save();
      logger.info(
        `[UserController->updatePassword] Successfully updated password for user ${userId}`,
        {
          request,
          security: true,
        },
      );
    } else {
      logger.warn(
        `[UserController->updatePassword] Could not update password for user ${userId}. Old password is wrong.`,
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
  async setPrimaryEmail(request, internalArgs) {
    let email = '';
    let userId = '';

    //
    // Determine source of arguments.
    //
    // If internalArgs is sent to this function then we prefer those values.
    // We are executing on behalf of the user from within ViewController.
    //
    // Otherwise, use the normal URL param + payload to determine arg values.
    //
    if (internalArgs && internalArgs.userId && internalArgs.email) {
      userId = internalArgs.userId;
      email = internalArgs.email;
    } else {
      userId = request.params.id;
      email = request.payload.email;
    }

    if (!email) {
      logger.warn(
        '[UserController->setPrimaryEmail] No email in payload',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest();
    }

    const record = await User.findOne({ _id: userId }).catch((err) => {
      logger.error(
        `[UserController->setPrimaryEmail] ${err.message}`,
        {
          request,
          security: true,
          fail: true,
          stack_trace: err.stack,
        },
      );

      throw Boom.internal('There was a problem querying the database. Please try again.');
    });

    if (!record) {
      logger.warn(
        `[UserController->setPrimaryEmail] Could not find user ${userId}`,
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
        `[UserController->setPrimaryEmail] Email ${email} does not exist for user ${userId}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('Email does not exist');
    }
    if (!record.emails[index].validated) {
      logger.warn(
        `[UserController->setPrimaryEmail] Email ${record.emails[index]} has not been validated for user ${userId}`,
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
      `[UserController->setPrimaryEmail] Saved user ${userId} successfully`,
      {
        request,
        user: {
          id: userId,
          email,
        },
      },
    );

    return record;
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
  async addEmail(request, internalArgs) {
    let userId = '';
    let email = '';
    let appValidationUrl = '';

    // eslint-disable-next-line max-len
    if (internalArgs && internalArgs.userId && internalArgs.email && internalArgs.appValidationUrl) {
      userId = internalArgs.userId;
      email = internalArgs.email;
      appValidationUrl = internalArgs.appValidationUrl;
    } else {
      userId = request.params.id;
      email = request.payload.email;
      appValidationUrl = request.payload.app_validation_url;
    }

    // Is the payload complete enough to take action?
    if (!appValidationUrl || !email) {
      logger.warn(
        '[UserController->addEmail] Either email or app_validation_url was not provided',
        {
          request,
          fail: true,
          user: {
            id: userId,
          },
        },
      );
      throw Boom.badRequest('Required parameters not present in payload');
    }

    // Is the verification link pointing to a domain in our allow-list?
    if (!HelperService.isAuthorizedUrl(appValidationUrl)) {
      logger.warn(
        `[UserController->addEmail] app_validation_url ${appValidationUrl} is not in allowedDomains list`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Invalid app_validation_url');
    }

    // Does the target user exist?
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

    // Make sure the email us unique to the target user's profile. Checking just
    // the target user first allows us to display better user feedback when the
    // request comes internally from HID Auth interface.
    if (record.emailIndex(email) !== -1) {
      logger.warn(
        `[UserController->addEmail] Email ${email} already belongs to ${userId}.`,
        {
          request,
          fail: true,
          user: {
            id: userId,
            email: record.email,
          },
        },
      );
      throw Boom.badRequest('Email already exists');
    }

    // Make sure email added is unique to the entire HID system.
    const erecord = await User.findOne({ 'emails.email': email });
    if (erecord) {
      logger.warn(
        `[UserController->addEmail] Email ${email} is not unique`,
        {
          request,
          fail: true,
          user: {
            id: userId,
            email: record.email,
          },
        },
      );
      throw Boom.badRequest('Email is not unique');
    }

    const data = {
      email,
      type: 'Work',
      validated: false,
    };
    record.emails.push(data);
    record.lastModified = new Date();

    const savedRecord = await record.save();
    logger.info(
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
    await EmailService.sendValidationEmail(
      record,
      email,
      savedEmail._id.toString(),
      appValidationUrl,
    );

    // If the email sent without error, notify the other emails on this account.
    const promises = [];
    for (let i = 0; i < record.emails.length; i++) {
      // TODO: probably shouldn't send notices to unconfirmed email addresses.
      //
      // @see HID-2150
      promises.push(EmailService.sendEmailAlert(record, record.emails[i].email, email));
    }

    // Send notifications to secondary addresses.
    await Promise.all(promises);

    // Return user object.
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
  async dropEmail(request, internalArgs) {
    let userId;
    let email;

    if (internalArgs && internalArgs.userId && internalArgs.email) {
      userId = internalArgs.userId;
      email = internalArgs.email;
    } else {
      userId = request.params.id;
      email = request.params.email;
    }

    if (!email) {
      logger.warn(
        '[UserController->dropEmail] No email provided',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest();
    }

    const record = await User.findOne({ _id: userId });
    if (!record) {
      logger.warn(
        `[UserController->dropEmail] User ${userId} not found`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    if (email === record.email) {
      logger.warn(
        `[UserController->dropEmail] Primary email for user ${userId} can not be removed`,
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

    await record.save();
    logger.info(
      `[UserController->dropEmail] User ${userId} saved successfully`,
      {
        request,
        user: {
          id: userId,
          email: record.email,
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
   *   description: >-
   *     Send a payload with `request.params.email` populated, plus a payload
   *     containing `app_validation_url` in order to have HID send an email to
   *     validate an address.
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
  async validateEmail(request, reply) {
    if (request.payload && request.payload.hash) {
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

      // Assign the primary address as the initial value for `email`
      //
      // This is necessary for new account registrations, which won't have the
      // emailId parameter sent along with their confirmation link since the new
      // account only has a single primary email address and no secondaries.
      let { email } = record;

      // If we are verifying a secondary email on an existing account, we need
      // to look up the emailId being confirmed in order to validate the hash.
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
        } else {
          for (let i = 0, len = record.emails.length; i < len; i += 1) {
            if (record.emails[i].email === email) {
              record.emails[i].validated = true;
              record.emails.set(i, record.emails[i]);
            }
          }
          record.lastModified = new Date();
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

      await record.save().then(() => {
        logger.info(
          `[UserController->validateEmail] Saved user ${record.id} successfully`,
          {
            request,
            user: {
              id: record.id,
              email: record.email,
            },
          },
        );
      });

      // TODO: if someone needs to re-verify an existing primary email address
      //       we end up sending them a "welcome to HID" email due to this simple
      //       conditional. We might want to consider a more complex conditional
      //       to avoid that edge case.
      //
      // @see HID-2200
      if (record.email === email) {
        await EmailService.sendPostRegister(record);
      }

      return record;
    }

    // When hash wasn't present, send a validation email to the requested address.
    //
    // @TODO: split this into its own function.
    //
    // @see HID-2064

    // Confirm whether a user exists with the requested email.
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

    // Confirm whether the request came from a valid domain.
    const appValidationUrl = request.payload && request.payload.app_validation_url ? request.payload.app_validation_url : '';
    if (!HelperService.isAuthorizedUrl(appValidationUrl)) {
      logger.warn(
        `[UserController->validateEmail] app_validation_url ${appValidationUrl} is not in allowedDomains list`,
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Invalid app_validation_url');
    }

    // Send validation email.
    const emailIndex = record.emailIndex(request.params.email);
    const email = record.emails[emailIndex];
    await EmailService.sendValidationEmail(
      record,
      email.email,
      email._id.toString(),
      appValidationUrl,
    );

    // Send a 204 (empty body)
    return reply.response().code(204);
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
  async resetPasswordEndpoint(request, reply) {
    if (request.payload && request.payload.email) {
      // Validate app URL.
      const appResetUrl = request.payload.app_reset_url || '';
      if (!HelperService.isAuthorizedUrl(appResetUrl)) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] app_reset_url ${appResetUrl} is not in allowedDomains list`,
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('app_reset_url is invalid');
      }

      // Lookup user based on the email address. We scan the `emails` array so
      // that secondary addresses can also receive password resets.
      const record = await User.findOne({ 'emails.email': request.payload.email.toLowerCase() });

      // No user found.
      if (!record) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] No user found with email: ${request.payload.email}`,
          {
            request,
            fail: true,
          },
        );

        // Send HTTP 204 (empty success response)
        //
        // We send this because disclosing the existence (or lack thereof) of an
        // email address is considered a security hole, per OICT policy.
        return reply.response().code(204);
      }

      // Determine whether email is primary. We allow unvalidated primary emails
      // to accept password resets.
      const emailIsPrimary = record.email === request.payload.email.toLowerCase();

      // Verify that the email has already been validated
      // eslint-disable-next-line max-len
      const secondaryEmailIsValidated = record.emails.some(e => e.email === request.payload.email.toLowerCase() && e.validated === true);

      // IF the email is primary OR it's a __validated__ secondary email
      // THEN send password reset.
      if (emailIsPrimary || secondaryEmailIsValidated) {
        await EmailService.sendResetPassword(record, appResetUrl, request.payload.email);
      } else {
        logger.warn(
          `[UserController->resetPasswordEndpoint] Could not reset password because the secondary email ${request.payload.email} has not been validated.`,
          {
            request,
            security: true,
            fail: true,
            user: {
              id: record.id,
              email: record.email,
            },
          },
        );
      }

      // Send HTTP 204 (empty success response)
      return reply.response().code(204);
    }

    // If `request.payload.email` was empty, we seem to be evaluating the reset
    // link contained within an email. This is not an API call, instead a normal
    // page load from a browser.
    const cookie = request.yar.get('session');
    if (
      !request.payload
      || !request.payload.hash
      || !request.payload.password
      || !request.payload.id
      || !request.payload.time
    ) {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Wrong or missing arguments',
        {
          request,
          security: true,
        },
      );
      throw Boom.badRequest('Wrong or missing arguments');
    }

    // Verify whether password requirements were met.
    if (!User.isStrongPassword(request.payload.password)) {
      logger.warn(
        '[UserController->resetPasswordEndpoint] Could not reset password. New password is not strong enough',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('New password is not strong enough');
    }

    // Lookup user by ID.
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

    // Check that whether a TOTP token is needed, and that it is valid.
    if (record.totp && !cookie) {
      const token = request.headers['x-hid-totp'];
      record = await AuthPolicy.isTOTPValid(record, token);
    }

    // Check that the reset hash was correct when the user landed on the page.
    if (record.validHash(request.payload.hash, 'reset_password', request.payload.time) === true) {
      // Check the new password against the old one.
      if (record.validPassword(request.payload.password)) {
        logger.warn(
          `[UserController->resetPasswordEndpoint] Could not reset password for user ${request.payload.id}. The new password can not be the same as the old one`,
          {
            request,
            security: true,
            fail: true,
            user: {
              id: request.payload.id,
            },
          },
        );
        throw Boom.badRequest('Could not reset password');
      } else {
        record.password = User.hashPassword(request.payload.password);
        record.verifyEmail(record.email);
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

    // Modify the user metadata now that password was reset.
    record.expires = new Date(0, 0, 1, 0, 0, 0);
    record.lastPasswordReset = new Date();
    record.passwordResetAlert30days = false;
    record.passwordResetAlert7days = false;
    record.passwordResetAlert = false;
    record.lastModified = new Date();

    // Update user in DB.
    await record.save().then(() => {
      logger.info(
        `[UserController->resetPasswordEndpoint] Password updated successfully for user ${record.id}`,
        {
          request,
          security: true,
          user: {
            id: record.id,
            email: record.email,
          },
        },
      );
    });

    return 'Password reset successfully';
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

    return record;
  },

  /*
   * @api [delete] /user/{id}/clients/{client}
   * tags:
   *   - user
   * summary: Revokes one OAuth Client from a user's profile.
   * parameters:
   *   - name: id
   *     in: path
   *     description: The user ID
   *     required: true
   *     type: string
   *   - name: client
   *     in: path
   *     description: The OAuth Client ID
   *     required: true
   *     type: string
   * responses:
   *   '200':
   *     description: OAuth Client revoked successfully. Returns user object.
   *   '400':
   *     description: Bad request. See response body for details.
   *   '401':
   *     description: Requesting user lacks permission to view requested user.
   *   '404':
   *     description: Requested user not found.
   */
  async revokeOauthClient(request, internalArgs) {
    let userId;
    let clientId;

    if (internalArgs && internalArgs.userId && internalArgs.clientId) {
      userId = internalArgs.userId;
      clientId = internalArgs.clientId;
    } else {
      userId = request.params.id;
      clientId = request.params.client;
    }

    // Validate presence of userId param.
    if (!userId) {
      logger.warn(
        '[UserController->revokeOauthClient] No userId provided',
        {
          request,
          fail: true,
        },
      );
      throw Boom.badRequest('No userId provided.');
    }

    // Validate presence of clientId param.
    if (!clientId) {
      logger.warn(
        '[UserController->revokeOauthClient] No clientId provided',
        {
          request,
          fail: true,
          user: {
            id: userId,
          },
        },
      );
      throw Boom.badRequest('No clientId provided.');
    }

    // Look up user from DB.
    const user = await User.findOne({ _id: userId });

    // Validate that user was found in DB.
    if (!user) {
      logger.warn(
        `[UserController->revokeOauthClient] No user found with id ${userId}`,
        {
          request,
          fail: true,
        },
      );
      throw Boom.notFound();
    }

    // Make sure this OAuth Client exists on the user profile.
    if (!user.authorizedClients.some(client => client._id.toString() === clientId)) {
      logger.warn(
        '[UserController->revokeOauthClient] Requested clientId not found on user profile.',
        {
          request,
          fail: true,
          user: {
            id: userId,
            email: user.email,
          },
          oauth: {
            id: clientId,
          },
        },
      );
      throw Boom.badRequest('Client ID not found on user profile.');
    }

    // Validation passed, user exists, client exists on user, so let's remove it.
    try {
      // eslint-disable-next-line max-len
      const remainingClients = user.authorizedClients.filter(client => client._id.toString() !== clientId);
      user.authorizedClients = remainingClients;
      await user.save();

      logger.info(
        '[UserController->revokeOauthClient] Successfully revoked OAuth Client from user.',
        {
          security: true,
          user: {
            id: userId,
            email: user.email,
          },
          oauth: {
            id: clientId,
          },
        },
      );

      return user;
    } catch (err) {
      logger.error(
        `[UserController->revokeOauthClient] ${err.message}`,
        {
          fail: true,
          stack_trace: err.stack,
        },
      );

      throw Boom.internal('Internal server error.');
    }
  },
};
