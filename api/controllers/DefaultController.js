'use strict';

const Controller = require('trails/controller');

/**
 * @module DefaultController
 *
 * @description Default Controller included with a new Trails app
 * @see {@link http://trailsjs.io/doc/api/controllers}
 * @this TrailsApp
 */
module.exports = class DefaultController extends Controller {

  /**
   * Return some info about this application
   */
  info (request, reply) {
    reply(this.app.services.DefaultService.getApplicationInfo());
  }

  migrateUsers (request, reply) {
    reply();
    this.app.config.migrate.migrate(this.app);
  }

  migrateAuth (request, reply) {
    reply();
    this.app.config.migrate.migrateAuth(this.app);
  }

  migrateLists (request, reply) {
    reply();
    this.app.config.migrate.migrateLists(this.app);
  }

  migrateServices (request, reply) {
    reply();
    this.app.config.migrate.migrateServices(this.app);
  }

  importLists (request, reply) {
    reply();
    this.app.config.cron.importLists(this.app);
  }
};
