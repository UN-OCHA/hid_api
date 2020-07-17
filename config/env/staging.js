const winston = require('winston');
const { hidFormatter } = require('../logs');
require('winston-daily-rotate-file');

module.exports = {
  database: {
    stores: {
      staging: {
        migrate: 'create',
        uri: 'mongodb://db:27017/staging',
        options: {
          keepAlive: 600000,
          connectTimeoutMS: 60000,
          useNewUrlParser: true,
          useUnifiedTopology: true,
        },
      },
    },
    models: {
      defaultStore: 'staging',
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
      new winston.transports.DailyRotateFile({
        name: 'info-file',
        filename: 'trails/info.log',
        level: 'debug',
        timestamp: true,
      }),
      new winston.transports.DailyRotateFile({
        name: 'error-file',
        filename: 'trails/error.log',
        level: 'error',
        timestamp: true,
      }),
    ],
  }),
};
