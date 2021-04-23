const Boom = require('@hapi/boom');
const Client = require('../models/Client');
const HelperService = require('../services/HelperService');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
 * @module ClientController
 * @description Controller for Clients.
 */
module.exports = {

  /*
   * @api [post] /client
   * tags:
   *   - client
   * summary: Create a new client.
   * requestBody:
   *   description: Client object
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         $ref: '#/components/schemas/Client'
   * responses:
   *   '200':
   *     description: Client created successfully.
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/Client'
   *   '400':
   *     description: Bad request. See response body for details.
   *   '403':
   *     description: Unauthorized. You are not an admin.
   */
  async create(request) {
    const payload = request.payload || {};
    const client = await Client.create(payload).catch((err) => {
      logger.warn(
        '[ClientController->create] Could not create client due to bad request',
        {
          request,
          stack_trace: err.message, // err.message contains the most useful error from Mongo
        },
      );
    });

    if (client) {
      logger.info(
        '[ClientController->create] Created a new client',
        {
          request,
          oauth: {
            client_id: payload.client_id,
          },
        },
      );
      return client;
    }

    throw Boom.badRequest();
  },

  /*
   * @api [get] /client
   * tags:
   *   - client
   * summary: Returns all the clients the user has access to.
   * parameters:
   *   - name: sort
   *     in: query
   *     required: false
   *     schema:
   *       type: string
   *       default: name
   *     description: Sort by this attribute.
   *   - name: offset
   *     in: query
   *     required: false
   *     schema:
   *       type: integer
   *       default: 0
   *     description: Offset list by this many clients.
   *   - name: limit
   *     in: query
   *     required: false
   *     schema:
   *       type: integer
   *       default: 100
   *     description: Limit list to this many clients.
   * responses:
   *   '200':
   *     description: Array of client objects.
   *     content:
   *       application/json:
   *         schema:
   *           type: array
   *           items:
   *             $ref: '#/components/schemas/Client'
   *   '400':
   *     description: Bad request. See response body for details.
   *   '403':
   *     description: Unauthorized. You are not an admin.
   *   '404':
   *     description: Requested client not found.
   */

  /*
   * @api [get] /client/{id}
   * tags:
   *   - client
   * summary: Returns one client with the specified ID.
   * parameters:
   *   - name: id
   *     in: path
   *     required: true
   *     description: A 24-character alphanumeric Client ID
   * responses:
   *   '200':
   *     description: The client object.
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/Client'
   *   '400':
   *     description: Bad request. See response body for details.
   *   '403':
   *     description: Unauthorized. You are not an admin.
   *   '404':
   *     description: Requested client not found.
   */
  async find(request, reply, internalArgs) {
    let user, options, criteria, clientId, sort;

    if (internalArgs && internalArgs.user) {
      user = internalArgs.user;
      options = HelperService.getOptionsFromQuery(internalArgs.options || {});
      criteria = HelperService.getCriteriaFromQuery(internalArgs.criteria || {});
      clientId = internalArgs.id || null;
      sort = internalArgs.sort || 'name';
    } else {
      user = request.auth.credentials;
      options = HelperService.getOptionsFromQuery(request.query);
      criteria = HelperService.getCriteriaFromQuery(request.query);
      clientId = request.params.id || null;
      sort = request.query.sort || 'name';
    }

    // If we have a specific Client ID, try to look it up.
    if (clientId) {
      criteria._id = clientId;
      const result = await Client.findOne(criteria).then(client => {
        logger.info(
          `[ClientController->find] Admin viewed a single OAuth Client with ID ${client._id}`,
          {
            security: true,
            user: {
              id: user.id,
              email: user.email,
              admin: user.is_admin,
            },
            oauth: {
              client_id: client.id,
            },
          }
        );

        return client;
      });

      if (!result) {
        logger.warn(
          `[ClientController->find] Could not find client with ID ${clientId}`,
          {
            security: true,
            user: {
              id: user.id,
              email: user.email,
              admin: user.is_admin,
            },
          },
        );
        throw Boom.notFound();
      }

      return result;
    }

    // Otherwise do a larger query for multiple records.
    options.sort = sort;
    const results = await HelperService.find(Client, criteria, options);

    // Count results and totals for pagination+logging
    const count = results.length;
    const total = await Client.countDocuments(criteria);

    logger.info(
      `[ClientController->find] Admin viewed a list of OAuth Clients containing ${count} records`,
      {
        security: true,
        user: {
          id: user.id,
          email: user.email,
          admin: user.is_admin,
        },
      }
    );

    // Send response.
    return reply.response(results).header('X-Total-Count', total);
  },

  /*
   * @api [put] /client/{id}
   * tags:
   *   - client
   * summary: Update client with the specified ID.
   * parameters:
   *   - name: id
   *     in: path
   *     required: true
   *     description: A 24-character alphanumeric Client ID
   * requestBody:
   *   description: Client object
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         $ref: '#/components/schemas/Client'
   * responses:
   *   '200':
   *     description: >-
   *       The client object.
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/Client'
   *   '400':
   *     description: Bad request. See response body for details.
   *   '403':
   *     description: Unauthorized. You are not an admin.
   *   '404':
   *     description: Requested client not found.
   */
  async update(request, internalArgs) {
    let clientId, clientData;

    if (internalArgs && internalArgs.clientId && internalArgs.clientData) {
      clientId = internalArgs.clientId;
      clientData = internalArgs.clientData;
    } else {
      clientId = request.params.id;
      clientData = request.payload;
    }

    // Read record from DB.
    const client = await Client.findOne({ _id: clientId });

    // Update with the form submission data.
    client.id = clientData.id;
    client.name = clientData.name;
    client.secret = clientData.secret;
    client.redirectUri = clientData.redirectUri;
    client.redirectUrls = clientData.redirectUrls;
    client.description = clientData.description;
    client.organization = clientData.organization;
    client.environment = clientData.environment;

    // Write to DB.
    const result = await client.save().then(data => {
      logger.info(
        '[ClientController->update] Updated client',
        {
          security: true,
          request,
        },
      );

      return client;
    }).catch(err => {
      throw Boom.badRequest(err.message);
    });

    return result;
  },

  /*
   * @api [delete] /client/{id}
   * tags:
   *   - client
   * summary: Deletes the client with the specified ID.
   * parameters:
   *   - name: id
   *     in: path
   *     required: true
   *     description: A 24-character alphanumeric Client ID
   * responses:
   *   '204':
   *     description: Client successfully deleted.
   *   '400':
   *     description: Bad request. See response body for details.
   *   '403':
   *     description: Unauthorized. You are not an admin.
   *   '404':
   *     description: Requested client not found.
   */
  async destroy(request, reply) {
    const client = await Client.findOne({ _id: request.params.id });

    // If a client was found, delete it and log the event.
    if (client) {
      await client.remove();

      logger.info(
        '[ClientController->destroy] Removed client',
        {
          request,
        },
      );

      return reply.response().code(204);
    }

    // If no client was found, return 404.
    throw Boom.notFound();
  },
};
