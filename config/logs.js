const _ = require('lodash');

module.exports = {
  hidFormatter(level, msg, logObject) {
    const localLogObject = _.clone(logObject || {});
    const metadata = {};

    let ip = '';
    if (logObject.request && logObject.request.info && logObject.request.info.remoteAddress) {
      ip = logObject.request.info.remoteAddress;
    }
    if (logObject.request && logObject.request.headers && logObject.request.headers['x-forwarded-for']) {
      ip = logObject.request.headers['x-forwarded-for'];
    }

    // Extend metadata with some defaults.
    metadata.level = level;
    metadata.ip = ip;

    // Include custom user object from log
    metadata.user = localLogObject.user || {};

    // Check if we received a request object
    if (localLogObject.request) {
      // Include relevant chunks of the node.js request object. If we include
      // whole object wholesale, the recursion creates gigantic, useless logs.
      metadata.request = {
        path: localLogObject.request.path || {},
        query: localLogObject.request.query || {},
        payload: localLogObject.request.payload || {},
        headers: localLogObject.request.headers || {},
        auth: localLogObject.request.auth || {},
      };

      // Try to automatically detect user unless logObject.user.id already exists.
      if (logObject.request.params && logObject.request.params.currentUser) {
        if (typeof metadata.user.id === 'undefined') {
          metadata.user.id = logObject.request.params.currentUser._id.toString();
        }
      }

      // Sanitize passwords
      if (localLogObject.request.payload && localLogObject.request.payload.password) {
        delete localLogObject.request.payload.password;
      }
      if (localLogObject.request.payload && localLogObject.request.payload.confirm_password) {
        delete localLogObject.request.payload.confirm_password;
      }

      // Sanitize OAuth client secrets
      if (metadata.request.query && typeof metadata.request.query.client_secret !== 'undefined') {
        // display first/last three characters but scrub the rest
        const sanitizedSecret = `${metadata.request.query.client_secret.slice(0, 3)}...${metadata.request.query.client_secret.slice(-3)}`;
        metadata.request.query.client_secret = sanitizedSecret;
      }

      // Sanitize JWTs, which can allow anyone to masquerade as this user.
      // We do this by removing the signature at the end, which only our
      // server can generate. That way, we can decode and inspect the payload
      // for debugging purposes, without risking the use of the JWT by devs
      // who have access to ELK.
      if (metadata.request.headers && metadata.request.headers.authorization) {
        let sanitizedJWT = metadata.request.headers.authorization.split('.');
        const buffer = Buffer.from(sanitizedJWT[1], 'base64');
        const asciiJWT = buffer.toString('ascii');
        sanitizedJWT.pop();
        sanitizedJWT = sanitizedJWT.join('.');
        metadata.request.headers.authorization = sanitizedJWT;

        // Auto-populate requesting user ID from JWT unless user.id was explicitly
        // passed into the log.
        if (typeof metadata.user.id === 'undefined') {
          metadata.user.id = JSON.parse(asciiJWT).id;
        }
      }

      // Sanitize credentials, which seems to contain the entire user object
      // from HID, including numerous pieces of sensitive data.
      if (metadata.request.auth && metadata.request.auth.credentials) {
        // Log whether this user is admin or not.
        metadata.user.admin = metadata.request.auth.credentials.is_admin;

        // Now delete the credentials object.
        delete metadata.request.auth.credentials;
      }
    }

    return metadata;
  },
};
