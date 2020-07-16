

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

        // Include custom user object from log
        metadata.user = localLogObject.user || {};

        // Avoid logging sensitive data
        if (
          localLogObject.request
          && localLogObject.request.payload
          && localLogObject.request.payload.password
        ) {
          delete localLogObject.request.payload.password;
        }

        if (
          localLogObject.request
          && localLogObject.request.payload
          && localLogObject.request.payload.confirm_password
        ) {
          delete localLogObject.request.payload.confirm_password;
        }

        // Check if we received a request object
        if (localLogObject.request) {
          // Include relevant chunks of the node.js request object. If we include
          // whole object wholesale, the recursion creates gigantic, useless logs.
          metadata.request = {
            path: localLogObject.request.path || {},
            headers: localLogObject.request.headers || {},
            query: localLogObject.request.query || {},
            url: localLogObject.request.url || {},
            auth: localLogObject.request.auth || {},
            payload: localLogObject.request.payload || {},
          };

          // Sanitize things we know contain sensitive data
          if (metadata.request.query && typeof metadata.request.query.client_secret !== 'undefined') {
            // display first/last three characters but scrub the rest
            const sanitizedSecret = `${metadata.request.query.client_secret.slice(0, 3)}...${metadata.request.query.client_secret.slice(-3)}`;
            metadata.request.query.client_secret = sanitizedSecret;
          }
        } // end of preprocessing localLogObject.request

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
