const winston = require('winston');
const { hidFormatter } = require('../logs');

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
      hidFormatter,
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
