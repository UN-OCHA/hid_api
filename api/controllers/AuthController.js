const Boom = require('@hapi/boom');
const Hawk = require('@hapi/hawk');
const Client = require('../models/Client');
const Flood = require('../models/Flood');
const JwtToken = require('../models/JwtToken');
const OauthToken = require('../models/OauthToken');
const User = require('../models/User');
const JwtService = require('../services/JwtService');
const HelperService = require('../services/HelperService');
const AuthPolicy = require('../policies/AuthPolicy');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
 * @module AuthController
 * @description Controller for Auth.
 */

// Main helper function used for login. All logins go through this.
async function loginHelper(request) {
  const password = request.payload ? request.payload.password : false;
  let email = false;
  if (request.payload && request.payload.email) {
    email = request.payload.email.toLowerCase();
  }

  if (!email || !password) {
    const cuser = request.auth.credentials;
    if (!cuser) {
      logger.warn(
        '[AuthController->loginHelper] Could not log in because of an invalid JSON Web Token',
        {
          request,
          security: true,
          user: {
            email,
          },
        },
      );
      throw Boom.unauthorized('Invalid JSON Web Token');
    }
    cuser.sanitize(cuser);
    return cuser;
  }

  // If there has been 5 failed login attempts in the last 5 minutes, return
  // unauthorized.
  const now = Date.now();
  const offset = 5 * 60 * 1000;
  const d5minutes = new Date(now - offset);

  const [number, user] = await Promise.all([
    Flood.countDocuments({ type: 'login', email, createdAt: { $gte: d5minutes.toISOString() } }),
    User.findOne({ email }),
  ]);

  if (number >= 5) {
    logger.warn(
      '[AuthController->loginHelper] Account locked for 5 minutes',
      {
        request,
        security: true,
        fail: true,
        user: {
          email,
        },
      },
    );
    throw Boom.tooManyRequests('Your account has been locked for 5 minutes because of too many requests.');
  }
  if (!user) {
    logger.warn(
      '[AuthController->loginHelper] Unsuccessful login attempt due to invalid email address',
      {
        request,
        security: true,
        fail: true,
      },
    );
    throw Boom.unauthorized('invalid email or password');
  }
  if (!user.email_verified) {
    logger.warn(
      '[AuthController->loginHelper] Unsuccessful login attempt due to unverified email',
      {
        request,
        security: true,
        fail: true,
        user: {
          id: user._id,
          email,
        },
      },
    );
    throw Boom.unauthorized('Please verify your email address');
  }
  if (user.isPasswordExpired()) {
    logger.warn(
      '[AuthController->loginHelper] Unsuccessful login attempt due to expired password',
      {
        request,
        security: true,
        fail: true,
        user: {
          id: user._id,
          email,
        },
      },
    );
    throw Boom.unauthorized('password is expired');
  }

  if (!user.validPassword(password)) {
    logger.warn(
      '[AuthController->loginHelper] Unsuccessful login attempt due to invalid password',
      {
        request,
        security: true,
        fail: true,
        user: {
          email,
        },
      },
    );
    // Create a flood entry
    await Flood.create({ type: 'login', email, user });
    throw Boom.unauthorized('invalid email or password');
  }
  return user;
}

function loginRedirect(request, reply, cookie = false) {
  let redirect = '';
  if (request.payload.response_type) {
    redirect = request.payload.redirect || '/oauth/authorize';
    redirect += `?client_id=${request.payload.client_id}`;
    redirect += `&redirect_uri=${request.payload.redirect_uri}`;
    redirect += `&response_type=${request.payload.response_type}`;
    redirect += `&scope=${request.payload.scope}`;
    if (request.payload.state) {
      redirect += `&state=${request.payload.state}`;
    }
    if (request.payload.nonce) {
      redirect += `&nonce=${request.payload.nonce}`;
    }
  } else {
    redirect = '/user';
  }

  logger.info(
    '[AuthController->loginRedirect] Successful user authentication. Redirecting.',
    {
      request,
      security: true,
      client_id: request.payload.client_id,
      email: request.payload.email,
    },
  );
  if (!cookie) {
    return reply.redirect(redirect);
  }

  return reply.redirect(redirect).state(cookie.name, cookie.value, cookie.options);
}

module.exports = {
  /*
   * @api [post] /jsonwebtoken
   * tags:
   *   - auth
   * summary: Generate a JSON web token (JWT)
   * parameters:
   *   - name: X-HID-TOTP
   *     in: header
   *     description: The TOTP token. Required if the user has 2FA enabled.
   *     required: false
   *     type: string
   * requestBody:
   *   description: 'User email and password'
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         $ref: '#/components/schemas/Auth'
   * responses:
   *   '200':
   *     description: >-
   *       The User object with the JWT contained in the `token` property.
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/JWT'
   *   '400':
   *     description: 'Bad request. Missing email and/or password'
   *   '401':
   *     description: 'Wrong email and/or password'
   *   '429':
   *     description: >-
   *       The account was locked for 5 minutes because there were more than 5
   *       unsuccessful login attempts within the last 5 minutes
   * security: []
   */
  async authenticate(request) {
    const result = await loginHelper(request);
    if (result.totp === true) {
      // Check to see if device is not a trusted device
      const trusted = request.state['x-hid-totp-trust'];
      if (!trusted || (trusted && !result.isTrustedDevice(request.headers['user-agent'], trusted))) {
        const token = request.headers['x-hid-totp'];
        await AuthPolicy.isTOTPValid(result, token);
      }
    }
    const payload = { id: result._id };
    if (request.payload && request.payload.exp) {
      payload.exp = request.payload.exp;
    }
    const token = JwtService.issue(payload);
    result.sanitize(result);
    if (!payload.exp) {
      // Creating an API key, store the token in the database
      await JwtToken.create({
        token,
        user: result._id,
        blacklist: false,
        // TODO: add expires
      });
      logger.warn(
        '[AuthController->authenticate] Created an API key',
        {
          request,
          security: true,
          email: result.email,
        },
      );
      return {
        user: result,
        token,
      };
    }
    logger.info(
      '[AuthController->authenticate] Successful user authentication. Returning JWT.',
      {
        request,
        security: true,
        email: result.email,
      },
    );
    return { user: result, token };
  },

  /**
   * Create a session and redirect to /oauth/authorize
   */
  async login(request, reply) {
    const cookie = request.yar.get('session');
    if (cookie && cookie.userId && cookie.totp === false) {
      try {
        const now = Date.now();
        const offset = 5 * 60 * 1000;
        const d5minutes = new Date(now - offset);
        const [number, user] = await Promise.all([
          Flood.count({ type: 'totp', email: cookie.userId, createdAt: { $gte: d5minutes.toISOString() } }),
          User.findOne({ _id: cookie.userId }),
        ]);
        if (number >= 5) {
          logger.warn(
            '[AuthController->login] Account locked for 5 minutes',
            {
              request,
              security: true,
              fail: true,
              user_id: cookie.userId,
            },
          );
          throw Boom.tooManyRequests('Your account has been locked for 5 minutes because of too many requests.');
        }
        const token = request.payload['x-hid-totp'];
        try {
          await AuthPolicy.isTOTPValid(user, token);
        } catch (err) {
          if (err.output.statusCode === 401) {
            // Create a flood entry
            await Flood
              .create({ type: 'totp', email: cookie.userId, user });
          }
          throw err;
        }
        cookie.totp = true;
        request.yar.set('session', cookie);
        if (request.payload['x-hid-totp-trust']) {
          await HelperService.saveTOTPDevice(request, user);
          const tindex = user.trustedDeviceIndex(request.headers['user-agent']);
          const random = user.totpTrusted[tindex].secret;
          return loginRedirect(request, reply, {
            name: 'x-hid-totp-trust',
            value: random,
            options: {
              ttl: 30 * 24 * 60 * 60 * 1000, domain: 'humanitarian.id', isSameSite: false, isHttpOnly: false,
            },
          });
        }
        return loginRedirect(request, reply);
      } catch (err) {
        const alert = {
          type: 'danger',
          message: err.output.payload.message,
        };
        return reply.view('totp', {
          title: 'Enter your Authentication code',
          query: request.payload,
          destination: '/login',
          alert,
        });
      }
    }
    if (cookie && cookie.userId && cookie.totp === true) {
      return loginRedirect(request, reply);
    }
    try {
      const result = await loginHelper(request);
      if (!result.totp) {
        // Store user login time.
        result.auth_time = new Date();
        await result.save();
        request.yar.set('session', { userId: result._id, totp: true });
        return loginRedirect(request, reply);
      }
      // Check to see if device is not a trusted device
      const trusted = request.state['x-hid-totp-trust'];
      if (trusted && result.isTrustedDevice(request.headers['user-agent'], trusted)) {
        // If trusted device, go on
        // Store user login time.
        result.auth_time = new Date();
        await result.save();
        request.yar.set('session', { userId: result._id, totp: true });
        return loginRedirect(request, reply);
      }
      request.yar.set('session', { userId: result._id, totp: false });
      return reply.view('totp', {
        title: 'Enter your Authentication code',
        query: request.payload,
        destination: '/login',
        alert: false,
      });
    } catch (err) {
      const params = HelperService.getOauthParams(request.payload);

      let registerLink = '/register';
      if (params) {
        registerLink += `?${params}`;
      }

      let passwordLink = '/password';
      if (params) {
        passwordLink += `?${params}`;
      }

      let alertMessage = 'We could not log you in. The username or password you have entered are incorrect. Kindly try again.';
      if (err.message === 'password is expired') {
        alertMessage = 'We could not log you in because your password is expired. Following UN regulations, as a security measure passwords must be udpated every six months. Kindly reset your password by clicking on the "Forgot/Reset password" link below.';
      }
      return reply.view('login', {
        title: 'Log into Humanitarian ID',
        query: request.payload,
        registerLink,
        passwordLink,
        alert: {
          type: 'danger',
          message: alertMessage,
        },
      });
    }
  },

  async authorizeDialogOauth2(request, reply) {
    try {
      const oauth = request.server.plugins['hapi-oauth2orize'];
      const prompt = request.query.prompt ? request.query.prompt : '';

      // Check response_type
      if (!request.query.response_type) {
        logger.warn(
          '[AuthController->authorizeDialogOauth2] Unsuccessful OAuth2 authorization due to missing response_type',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: request.query.client_id,
            },
          },
        );

        return reply.redirect(`${request.query.redirect_uri}?error=invalid_request&state=${request.query.state
        }&scope=${request.query.scope
        }&nonce=${request.query.nonce}`);
      }

      // If the user is not authenticated, redirect to the login page and preserve
      // all relevant query parameters.
      const cookie = request.yar.get('session');
      if (!cookie || (cookie && !cookie.userId) || (cookie && !cookie.totp) || prompt === 'login') {
        // If user is not logged in and prompt is set to none, throw an error message.
        if (prompt === 'none') {
          return reply.redirect(`${request.query.redirect_uri}?error=login_required&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce}`);
        }
        logger.info(
          '[AuthController->authorizeDialogOauth2] Get request to /oauth/authorize without session. Redirecting to the login page.',
          {
            request,
            security: true,
            oauth: {
              client_id: request.query.client_id,
            },
          },
        );
        return reply.redirect(
          `/?redirect=/oauth/authorize&client_id=${request.query.client_id
          }&redirect_uri=${request.query.redirect_uri
          }&response_type=${request.query.response_type
          }&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce}#login`,
        );
      }

      // If the user is authenticated, then check whether the user has confirmed
      // authorization for this client/scope combination.
      const user = await User.findOne({ _id: cookie.userId }).populate({ path: 'authorizedClients', select: 'id name' });
      const clientId = request.query.client_id;
      user.sanitize(user);
      request.auth.credentials = user;
      const result = await oauth.authorize(request, reply, {}, async (clientID, redirect, done) => {
        try {
          const client = await Client.findOne({ id: clientID });
          if (!client || !client.id) {
            logger.warn(
              '[AuthController->authorizeDialogOauth2] Unsuccessful OAuth2 authorization because client was not found',
              {
                request,
                security: true,
                fail: true,
                user: {
                  id: cookie.userId,
                },
                oauth: {
                  client_id: false,
                },
              },
            );
            return done(
              'An error occurred while processing the request. Please try logging in again.',
            );
          }
          // Verify redirect uri
          if (client.redirectUri !== redirect && !client.redirectUrls.includes(redirect)) {
            logger.warn(
              '[AuthController->authorizeDialogOauth2] Unsuccessful OAuth2 authorization due to wrong redirect URI',
              {
                request,
                security: true,
                fail: true,
                oauth: {
                  client_id: client.id,
                  redirect_uri: redirect,
                },
                user: {
                  id: cookie.userId,
                },
              },
            );
            return done('Wrong redirect URI');
          }
          return done(null, client, redirect);
        } catch (err) {
          logger.error(
            `[AuthController->authorizeDialogOauth2] ${err.message}`,
            {
              request,
              security: true,
              fail: true,
              user: {
                id: cookie.userId,
              },
              stack_trace: err.stack,
            },
          );
          return done('An error occurred while processing the request. Please try logging in again.');
        }
      });
      const req = result[0];
      if (user.authorizedClients && user.hasAuthorizedClient(clientId)) {
        request.payload = { transaction_id: req.oauth2.transactionID };
        const response = await oauth.decision(request, reply);
        return response;
      }
      // The user has not confirmed authorization, so present the
      // authorization page if prompt != none.
      if (prompt === 'none') {
        return reply.redirect(`${request.query.redirect_uri}?error=interaction_required&state=${request.query.state
        }&scope=${request.query.scope
        }&nonce=${request.query.nonce}`);
      }
      return reply.view('authorize', {
        user,
        client: req.oauth2.client,
        transactionID: req.oauth2.transactionID,
        // csrf: req.csrfToken()
      });
    } catch (err) {
      logger.error(
        `[AuthController->authorizeDialogOauth2] ${err.message}`,
        {
          request,
          security: true,
          fail: true,
          stack_trace: err.stack,
        },
      );
      return err;
    }
  },

  async authorizeOauth2(request, reply) {
    try {
      const oauth = request.server.plugins['hapi-oauth2orize'];
      const cookie = request.yar.get('session');

      if (!cookie || (cookie && !cookie.userId) || (cookie && !cookie.totp)) {
        logger.info(
          '[AuthController->authorizeOauth2] Got request to /oauth/authorize without session. Redirecting to the login page.',
          {
            request,
            oauth: {
              client_id: request.query.client_id,
            },
          },
        );
        return reply.redirect(`/?redirect=/oauth/authorize&client_id=${request.query.client_id
        }&redirect_uri=${request.query.redirect_uri
        }&response_type=${request.query.response_type
        }&state=${request.query.state
        }&scope=${request.query.scope
        }&nonce=${request.query.nonce}#login`);
      }

      const user = await User.findOne({ _id: cookie.userId });
      if (!user) {
        logger.warn(
          `[AuthController->authorizeOauth2] Unsuccessful OAuth2 authorization attempt. Could not find user with ID ${cookie.userId}`,
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: request.query.client_id,
            },
          },
        );
        throw Boom.badRequest('Could not find user');
      }
      user.sanitize(user);
      request.auth.credentials = user;

      // Save authorized client if user allowed
      const clientId = request.yar.authorize[request.payload.transaction_id].client;
      if (!request.payload.bsubmit || request.payload.bsubmit === 'Deny') {
        return reply.redirect('/');
      }
      if (!user.hasAuthorizedClient(clientId) && request.payload.bsubmit === 'Allow') {
        user.authorizedClients.push(request.yar.authorize[request.payload.transaction_id].client);
        user.markModified('authorizedClients');
        logger.info(
          '[AuthController->authorizeOauth2] Added authorizedClient to user',
          {
            request,
            security: true,
            user: {
              id: user._id,
              email: user.email,
            },
            oauth: {
              client_id: clientId,
            },
          },
        );
        await user.save();
      }
      const response = await oauth.decision(request, reply);
      return response;
    } catch (err) {
      logger.error(
        `[AuthController->authorizeOauth2] ${err.message}`,
        {
          request,
          security: true,
          fail: true,
          stack_trace: err.stack,
        },
      );
      return err;
    }
  },

  async accessTokenOauth2(request, reply) {
    try {
      const oauth = request.server.plugins['hapi-oauth2orize'];
      const { code } = request.payload;
      if (!code && request.payload.grant_type !== 'refresh_token') {
        logger.warn(
          '[AuthController->accessTokenOauth2] Unsuccessful access token request due to missing authorization code.',
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('Missing authorization code');
      }
      // Check client_id and client_secret
      let client = null;
      let clientId = null;
      let clientSecret = null;
      if (request.payload.client_id && request.payload.client_secret) {
        // Using client_secret_post authorization
        clientId = request.payload.client_id;
        clientSecret = request.payload.client_secret;
      } else if (request.headers.authorization) {
        // Using client_secret_basic authorization
        // Decrypt the Authorization header.
        const parts = request.headers.authorization.split(' ');
        if (parts.length === 2) {
          const credentials = parts[1];
          const buff = Buffer.from(credentials, 'base64');
          const text = buff.toString('ascii');
          const cparts = text.split(':');
          [clientId, clientSecret] = cparts;
        }
      } else {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to invalid client authentication.',
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('invalid client authentication');
      }
      // Using client_secret_post authentication method.
      client = await Client.findOne({ id: clientId });
      if (!client) {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to wrong client ID.',
          {
            request,
            security: true,
            fail: true,
          },
        );
        throw Boom.badRequest('invalid client_id');
      }
      if (clientSecret !== client.secret) {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to wrong client authentication.',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: client.id,
            },
          },
        );
        throw Boom.badRequest('invalid client_secret');
      }
      const token = request.payload.code ? request.payload.code : request.payload.refresh_token;
      const type = request.payload.code ? 'code' : 'refresh';
      const ocode = await OauthToken.findOne({ token, type }).populate('client user');
      if (!ocode) {
        logger.warn(
          '[AuthController->accessTokenOauth2] Unsuccessful access token request due to wrong authorization code.',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              code,
            },
          },
        );
        // OAuth2 standard error.
        const error = Boom.badRequest('invalid authorization code');
        error.output.payload.error = 'invalid_grant';
        throw error;
      } else {
        logger.info(
          '[AuthController->accessTokenOauth2] Successful access token request',
          {
            request,
            security: true,
          },
        );
        request.auth.credentials = ocode.client;
        const response = await oauth.token(request, reply);
        return response;
      }
    } catch (err) {
      logger.error(
        `[AuthController->accessTokenOauth2] ${err.message}`,
        {
          request,
          security: true,
          fail: true,
          stack_trace: err.stack,
        },
      );
      return err;
    }
  },

  openIdConfiguration() {
    const root = process.env.ROOT_URL;
    const out = {
      issuer: root,
      authorization_endpoint: `${root}/oauth/authorize`,
      token_endpoint: `${root}/oauth/access_token`,
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
      userinfo_endpoint: `${root}/account.json`,
      jwks_uri: `${root}/oauth/jwks`,
      response_types_supported: ['code', 'token', 'id_token', 'id_token token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile', 'phone'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'name',
        'given_name',
        'family_name',
        'middle_name',
        'picture',
        'email',
        'email_verified',
        'zoneinfo',
        'locale',
        'phone_number',
        'phone_number_verified',
        'updated_at',
      ],
    };
    return out;
  },

  jwks() {
    const key = JwtService.public2jwk();
    key.alg = 'RS256';
    const out = {
      keys: [
        key,
      ],
    };
    return out;
  },

  /*
   * @api [get] /jsonwebtoken
   *
   * tags:
   *   - auth
   * summary: Retrieve the JWTs of the current user
   * responses:
   *   '200':
   *     description: >-
   *       Array of all JWTs for the current user, including blacklisted tokens.
   */
  async jwtTokens(request) {
    const tokens = await JwtToken.find({ user: request.auth.credentials._id });
    return tokens;
  },

  /*
   * @api [delete] /jsonwebtoken
   *
   * tags:
   *   - auth
   * summary: Blacklists a JWT for the current user
   * requestBody:
   *   description: The token to blacklist.
   *   required: true
   *   content:
   *     application/json:
   *       schema:
   *         $ref: '#/components/schemas/JWT'
   * responses:
   *   '200':
   *     description: JWT was successfully blacklisted
   *     content:
   *       application/json:
   *         schema:
   *           $ref: '#/components/schemas/JWT'
   *   '400':
   *     description: Missing token
   *   '403':
   *     description: >-
   *       Could not blacklist this token because you did not generate it
   */
  async blacklistJwt(request) {
    const token = request.payload ? request.payload.token : null;
    if (!token) {
      logger.warn(
        '[AuthController->blacklistJwt] Missing token',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Missing token');
    }
    // Check that blacklisted token belongs to current user
    const jtoken = JwtService.verify(token);
    if (jtoken.id === request.auth.credentials.id) {
      // Blacklist token
      logger.info(
        '[AuthController->blacklistJwt] Blacklisting token',
        {
          request,
          security: true,
          jwt: jtoken.id,
        },
      );
      const doc = await JwtToken.findOneAndUpdate({ token }, {
        token,
        user: request.auth.credentials._id,
        blacklist: true,
      }, { upsert: true, new: true });
      return doc;
    }
    logger.warn(
      '[AuthController->blacklistJwt] Tried to blacklist a token by a user who does not have the permission',
      {
        request,
        security: true,
        fail: true,
      },
    );
    throw Boom.forbidden('Could not blacklist this token because you did not generate it');
  },

  /**
   * Creates short lived (5 minutes) tokens to
   * sign requests for file downloads.
   */
  signRequest(request) {
    const url = request.payload ? request.payload.url : null;
    if (!url) {
      logger.warn(
        '[AuthController->signRequest] Missing url to sign request for file downloads',
        {
          request,
          security: true,
          fail: true,
        },
      );
      throw Boom.badRequest('Missing url');
    }
    const credentials = {
      id: request.auth.credentials._id.toString(),
      key: process.env.COOKIE_PASSWORD,
      algorithm: 'sha256',
    };
    const bewit = Hawk.uri.getBewit(url, {
      credentials,
      ttlSec: 60 * 5,
    });
    return { bewit };
  },

};
