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
          stack_trace: err.message,
        },
      );
    });

    if (client) {
      logger.info(
        '[ClientController->create] Created a new client',
        {
          request,
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
   *     description: Sort by this attribute.
   *     in: query
   *     type: string
   *     required: false
   *     default: name
   *   - name: offset
   *     description: Offset list by this many clients.
   *     in: query
   *     type: integer
   *     required: false
   *     default: 0
   *   - name: limit
   *     description: Limit list to this many clients.
   *     in: query
   *     type: integer
   *     required: false
   *     default: 50
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
   *     description: A 24-character alphanumeric Client ID
   *     in: path
   *     required: true
   *     default: ''
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
  async find(request, reply) {
    const options = HelperService.getOptionsFromQuery(request.query);
    const criteria = HelperService.getCriteriaFromQuery(request.query);

    if (request.params.id) {
      criteria._id = request.params.id;
      const result = await Client.findOne(criteria);
      if (!result) {
        logger.warn(
          `[ClientController->find] Could not find client with ID ${request.params.id}`,
          {
            request,
          },
        );
        throw Boom.notFound();
      }
      return result;
    }
    const results = await HelperService.find(Client, criteria, options);
    const number = await Client.countDocuments(criteria);
    return reply.response(results).header('X-Total-Count', number);
  },

  /*
   * @api [put] /client/{id}
   * tags:
   *   - client
   * summary: Update client with the specified ID.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric Client ID
   *     in: path
   *     required: true
   *     default: ''
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
   *       The client object. _**NOTE:** at this time, the function returns the
   *       UNCHANGED client if the object you send contains validation errors._
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
  async update(request) {
    // @TODO: Make this return 401 with validation feedback like POST.
    //
    // @see HID-2080
    const client = await Client.findOneAndUpdate(
      { _id: request.params.id },
      request.payload,
      { runValidators: true, new: true },
    );

    logger.info(
      `[ClientController->update] Updated client ${request.params.id}`,
      {
        request,
      },
    );

    return client;
  },

  /*
   * @api [delete] /client/{id}
   * tags:
   *   - client
   * summary: Deletes the client with the specified ID.
   * parameters:
   *   - name: id
   *     description: A 24-character alphanumeric Client ID
   *     in: path
   *     required: true
   *     default: ''
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
        `[ClientController->destroy] Removed client ${request.params.id}`,
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
