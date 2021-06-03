const jwt = require('jsonwebtoken');
const fs = require('fs');
const rsa2jwk = require('rsa-pem-to-jwk');

/**
 * @module JwtService
 * @description JSON Web Token Service
 */
module.exports = {

  // Generates a token from supplied payload
  issue(payload) {
    const cert = fs.readFileSync('keys/sign.rsa');
    const options = { algorithm: 'RS256', header: { kid: `hid-v3-${process.env.NODE_ENV}` } };
    return jwt.sign(
      payload,
      cert,
      options,
    );
  },

  // Verifies token on a request
  verify(token) {
    let success = false;

    try {
      const cert = fs.readFileSync('keys/sign.rsa.pub');
      success = jwt.verify(token, cert);

      // If we loaded the key but sig was not verified, throw an error.
      if (!success) {
        throw new Error({});
      }
    } catch (err) {
      // During v3 transition period, we try again with the old key if our new
      // key is either missing.
      //
      // @see https://humanitarian.atlassian.net/browse/HID-2027
      const legacy = fs.readFileSync('keys/hid.rsa.pub');
      success = jwt.verify(token, legacy);
    }

    return success;
  },

  public2jwk() {
    let success = false;

    try {
      const cert = fs.readFileSync('keys/sign.rsa.pub');
      success = rsa2jwk(cert, { use: 'sig', kid: 'hid-v3' }, 'public');

      // If we loaded the key but sig was not verified, throw an error.
      if (!success) {
        throw new Error({});
      }
    } catch (err) {
      // During v3 transition period, we try again with the old key if our new key
      // cannot verify the JWT.
      //
      // @see https://humanitarian.atlassian.net/browse/HID-2027
      const legacy = fs.readFileSync('keys/hid.rsa.pub');
      success = rsa2jwk(legacy, { use: 'sig', kid: 'hid-v3' }, 'public');
    }

    return success;
  },

  generateIdToken(client, user, scope, nonce) {
    const now = Math.floor(Date.now() / 1000);
    let sub = user._id;
    if (client.id === 'iasc-prod' || client.id === 'iasc-dev') {
      sub = user.email;
    }
    const idToken = {
      iss: process.env.ROOT_URL,
      sub,
      aud: client.id,
      exp: now + 24 * 3600,
      nonce,
      iat: now,
      auth_time: Math.floor(user.auth_time.getTime() / 1000),
    };
    if (scope.indexOf('email') !== -1) {
      idToken.email = user.email;
      idToken.email_verified = user.email_verified;
    }
    if (scope.indexOf('profile') !== -1) {
      idToken.name = user.name;
      idToken.family_name = user.family_name;
      idToken.given_name = user.given_name;
      idToken.updated_at = user.updatedAt;
    }
    return this.issue(idToken);
  },

};
