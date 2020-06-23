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

  async create(request) {
    if (!request.payload) {
      throw Boom.badRequest('Payload was missing');
    }

    // If payload exists, attempt to create new Client.
    const client = await Client.create(request.payload).then(data => {
      logger.info(
        `[ClientController->create] Created a new client with id: ${data.id}`,
      );
      return data;
    }).catch(err => {
      logger.warn(
        '[ClientController->create] Could not create client due to bad request',
        request,
      );
      throw Boom.badRequest(err.message);
    });

    return client;
  },

  async find(request, reply) {
    const options = HelperService.getOptionsFromQuery(request.query);
    const criteria = HelperService.getCriteriaFromQuery(request.query);

    if (request.params.id) {
      criteria._id = request.params.id;
      const result = await Client.findOne(criteria);
      if (!result) {
        logger.warn(
          `[ClientController->find] Could not find client with ID ${request.params.id}`,
        );
        throw Boom.notFound();
      }
      return result;
    }
    const results = await HelperService.find(Client, criteria, options);
    const number = await Client.countDocuments(criteria);
    return reply.response(results).header('X-Total-Count', number);
  },

  async update(request) {
    const client = await Client
      .findOneAndUpdate(
        { _id: request.params.id },
        request.payload,
        { runValidators: true, new: true },
      );
    logger.info(
      `[ClientController->update] Updated client ${request.params.id}`,
      { request: request.payload },
    );
    return client;
  },

  async destroy(request, reply) {
    await Client.remove({ _id: request.params.id });
    logger.info(
      `[ClientController->destroy] Removed client ${request.params.id}`,
    );
    return reply.response().code(204);
  },
};
