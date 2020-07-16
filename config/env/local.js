

const winston = require('winston');
const os = require('os');
const _ = require('lodash');

module.exports = {
  database: {
    stores: {
      local: {
        migrate: 'create',
        uri: 'mongodb://db:27017/local',
        options: {
          keepAlive: 600000,
          connectTimeoutMS: 60000,
          useNewUrlParser: true,
          useUnifiedTopology: true,
        },
      },
    },
    models: {
      defaultStore: 'local',
      migrate: 'create',
    },
  },
  logger: new winston.Logger({
    level: 'debug',
    exitOnError: false,
    rewriters: [
      (level, msg, logObject) => {
        const localLogObject = _.clone(logObject || {});
        const metadata = {};

        let ip = '';
        if (logObject.request && logObject.request.info && logObject.request.info.remoteAddress) {
          ip = logObject.request.info.remoteAddress;
        }
        if (logObject.request && logObject.request.headers && logObject.request.headers['x-forwarded-for']) {
          ip = logObject.request.headers['x-forwarded-for'];
        }

        // Try to automatically detect user.
        // This will get overwritten if payload.user exists.
        if (logObject.request && logObject.request.params && logObject.request.params.currentUser) {
          metadata.user.id = logObject.request.params.currentUser._id.toString();
        }

        // Extend metadata with some defaults.
        metadata.level = level;
        metadata.hostname = os.hostname();
        metadata.env = `hid-${process.env.NODE_ENV}`;
        metadata.ip = ip;
        metadata['@timestamp'] = new Date().toJSON();

        return metadata;
      },
    ],
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: '/var/log/local.log',
        timestamp: true,
      }),
    ],
  }),

};
