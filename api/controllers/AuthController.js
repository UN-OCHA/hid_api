/**
 * @module AuthController
 * @description Controller for Auth.
 */
const Boom = require('@hapi/boom');
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
 * Main helper function used for login. All logins go through this.
 */
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
          id: user.id,
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
          id: user.id,
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
          id: user.id,
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
      oauth: {
        client_id: request.payload.client_id,
      },
      user: {
        email: request.payload.email,
      },
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
   *     required: false
   *     schema:
   *       type: string
   *     description: The TOTP token. Required if the user has 2FA enabled.
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
        user: result._id.toString(),
        blacklist: false,
        // TODO: add expires
      });
      logger.warn(
        '[AuthController->authenticate] Created an API key',
        {
          request,
          security: true,
          user: {
            id: result._id.toString(),
            email: result.email,
          },
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
        user: {
          email: result.email,
        },
      },
    );
    return { user: result, token };
  },

  /**
   * POST Handler for login form submissions.
   *
   * Create a user session, and potentially redirect when the user arrived from
   * another website.
   */
  async login(request, reply) {
    // Grab cookie
    const cookie = request.yar.get('session');

    // It looks like TOTP is needed for this user.
    if (cookie && cookie.userId && cookie.totp === false) {
      try {
        // Prevent form spamming by counting submissions and locking accounts
        // which fail to login repeatedly in a short time window.
        const now = Date.now();
        const offset = 5 * 60 * 1000;
        const d5minutes = new Date(now - offset);
        const [floodCount, user] = await Promise.all([
          Flood.count({
            type: 'totp',
            email: cookie.userId,
            createdAt: {
              $gte: d5minutes.toISOString(),
            },
          }),
          User.findOne({ _id: cookie.userId }),
        ]);

        // If flood-count too high, lock further attempts.
        if (floodCount >= 5) {
          logger.warn(
            '[AuthController->login] Account locked for 5 minutes',
            {
              request,
              security: true,
              fail: true,
              user: {
                id: cookie.userId,
              },
            },
          );
          throw Boom.tooManyRequests('Your account has been locked for 5 minutes because of too many requests.');
        }

        // Check for TOTP codes
        const token = request.payload['x-hid-totp'];
        try {
          await AuthPolicy.isTOTPValid(user, token);
        } catch (err) {
          if (err.output.statusCode === 401) {
            // Create a flood entry
            await Flood.create({
              type: 'totp',
              email: cookie.userId,
              user,
            });
          }
          throw err;
        }

        // If we got here, the user passed TOTP.
        cookie.totp = true;
        request.yar.set('session', cookie);

        // If save device was checked, avoid TOTP prompts for 30 days.
        if (request.payload['x-hid-totp-trust']) {
          await HelperService.saveTOTPDevice(request, user);
          const tindex = user.trustedDeviceIndex(request.headers['user-agent']);
          const random = user.totpTrusted[tindex].secret;
          return loginRedirect(request, reply, {
            name: 'x-hid-totp-trust',
            value: random,
            options: {
              ttl: 30 * 24 * 60 * 60 * 1000,
              domain: 'humanitarian.id',
              isSameSite: false,
              isHttpOnly: false,
            },
          });
        }

        // Redirect.
        //
        // - For plain logins, this will go to user dashboard.
        // - For OAuth flows, this will either redirect to the Authorize prompt
        //   or it will directly send them back to the original site.
        return loginRedirect(request, reply);
      } catch (err) {
        // User needs TOTP and header wasn't present. Show TOTP prompt.
        const alert = {
          type: 'error',
          message: err.output.payload.message,
        };

        // Display form to user.
        return reply.view('totp', {
          title: 'Enter your Authentication code',
          query: request.payload,
          destination: '/login',
          alert,
        });
      }
    }

    // If the user has submitted the TOTP prompt, redirect.
    if (cookie && cookie.userId && cookie.totp === true) {
      return loginRedirect(request, reply);
    }

    try {
      const result = await loginHelper(request);
      if (!result.totp) {
        // Store user login time.
        result.auth_time = new Date();
        await result.save();
        request.yar.set('session', {
          userId: result._id,
          totp: true,
        });
        return loginRedirect(request, reply);
      }

      // Check to see if device is a trusted device.
      const trusted = request.state['x-hid-totp-trust'];
      if (trusted && result.isTrustedDevice(request.headers['user-agent'], trusted)) {
        // If trusted device, go onto store user login time.
        result.auth_time = new Date();
        await result.save();

        // Set cookie.
        request.yar.set('session', {
          userId: result._id,
          totp: true,
        });

        // Redirect
        return loginRedirect(request, reply);
      }

      // Set cookie
      request.yar.set('session', {
        userId: result._id,
        totp: false,
      });

      // Display TOTP prompt
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

      // Display login form to user.
      return reply.view('login', {
        title: 'Log into Humanitarian ID',
        query: request.payload,
        registerLink,
        passwordLink,
        alert: {
          type: 'error',
          message: alertMessage,
        },
      });
    }
  },

  /**
   * User-facing dialog to authorize an OAuth Client.
   *
   * This is the entry point for OAuth flows. Here's a list of potential events:
   *
   * - It requires an active user session so it first redirects to login form if
   *   the user isn't logged in.
   * - Once the user arrives back here with a session, the OAuth Client data is
   *   validated to ensure that it's a legitimate attempt from the real website.
   * - Now the user profile is checked to see if they have this OAuth Client in
   *   their approved list.
   * - If YES, they redirect back to the website. The end.
   * - If NO, they are presented with the Allow/Deny buttons. For further
   *   progress, look at submission handler.
   *
   * @see authorizeOauth2()
   */
  async authorizeDialogOauth2(request, reply) {
    // For some errors, we end up showing a prompt saying that the problem
    // originated on the website which sent the user to HID. It's not always
    // possible, but when we can we populate this URL so we can link them back
    // to where they came from.
    let errorRedirectUrl = '';

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

        return reply.redirect(
          `${request.query.redirect_uri
          }?error=invalid_request&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce
          }`);
      }

      // If the user is not authenticated, redirect to the login page and preserve
      // all relevant query parameters.
      const cookie = request.yar.get('session');
      if (!cookie || (cookie && !cookie.userId) || (cookie && !cookie.totp) || prompt === 'login') {
        // If user is not logged in and prompt is set to none, throw an error message.
        if (prompt === 'none') {
          return reply.redirect(
            `${request.query.redirect_uri
            }?error=login_required&state=${request.query.state
            }&scope=${request.query.scope
            }&nonce=${request.query.nonce
            }`);
        }
        logger.info(
          '[AuthController->authorizeDialogOauth2] Get request to /oauth/authorize without session. Redirecting to the login page.',
          {
            request,
            security: true,
            oauth: {
              client_id: request.query.client_id,
              redirect_uri: request.query.redirect_uri,
              response_type: request.query.response_type,
            },
          },
        );
        return reply.redirect(
          `/?redirect=/oauth/authorize&client_id=${request.query.client_id
          }&redirect_uri=${request.query.redirect_uri
          }&response_type=${request.query.response_type
          }&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce
          }#login`,
        );
      }

      // If the user is authenticated, then check whether the user has confirmed
      // authorization for this client/scope combination.
      const options = {};
      const user = await User.findOne({ _id: cookie.userId }).populate({ path: 'authorizedClients', select: 'id name' });
      const clientId = request.query.client_id;
      user.sanitize(user);
      request.auth.credentials = user;

      // Validate the OAuth Authorization request. If any parameters are missing
      // or invalid, it will throw an error internally, but will show a generic
      // message about configuration to the user.
      const [req, res] = await oauth.authorize(request, reply, options, async (oauthClientId, redirect, done) => {
        try {
          // Verify OAuth Client ID.
          const client = await Client.findOne({ id: oauthClientId });
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
                  client_id: oauthClientId,
                },
              },
            );

            throw Error(`Client ID does not exist: ${oauthClientId}`);
          }

          // Verify redirect_uri
          if (client.redirectUri !== redirect && !client.redirectUrls.includes(redirect)) {
            logger.warn(
              '[AuthController->authorizeDialogOauth2] Unsuccessful OAuth2 authorization due to wrong redirect URI',
              {
                request,
                security: true,
                fail: true,
                user: {
                  id: cookie.userId,
                },
                oauth: {
                  client_id: client.id,
                  redirect_uri: redirect,
                },
              },
            );

            // extract hostname from redirect URL
            errorRedirectUrl = new URL(redirect).origin;

            throw Error(`Wrong redirect URI: ${redirect}`);
          }

          // The request passed validation. Proceed.
          return done(null, client, redirect);
        } catch (err) {
          // Check the error object and potentially log the error if it does NOT
          // contain one of the validation problems we already logged. We log
          // validation problems before throwing in order to provide contextual
          // metadata in the logs, so that known problems can be more easily
          // found in Kibana.
          //
          // If we didn't find any known problems, we should log the error. This
          // conditional needs to have one test for each Error() in the preceding
          // try() block.
          if (
            err.message
            && err.message.indexOf('Client ID does not exist') === -1
            && err.message.indexOf('Wrong redirect URI') === -1
          ) {
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
          }

          // Finish the OAuth validation process.
          return done('catch()');
        }
      });

      // If we made it this far, the OAuth config seems legit. Check user data
      // to see if they already have this client in their approved list.
      if (user.authorizedClients && user.hasAuthorizedClient(clientId)) {
        request.payload = { transaction_id: req.oauth2.transactionID };
        const response = await oauth.decision(request, reply);
        return response;
      }

      // If prompt === none, redirect immediately.
      if (prompt === 'none') {
        return reply.redirect(
          `${request.query.redirect_uri
          }?error=interaction_required&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce
          }`);
      }

      // The user has not confirmed authorization, so display the authorization
      // dialog to the user and let them decide to approve/deny.
      return reply.view('authorize', {
        user,
        client: req.oauth2.client,
        transactionID: req.oauth2.transactionID,
        // csrf: req.csrfToken()
      });
    } catch (err) {
      // Display a human-friendly error.
      //
      // We're not doing additional logging in this block because we logged the
      // errors as they were caught in the code above.
      return reply.view('message', {
        title: 'Configuration problem on original website',
        alert: {
          type: 'error',
          message: `
            <p>The website which sent you to HID appears to have invalid configuration.</p>
            <p>We have logged the problem internally.</p>
            ${ errorRedirectUrl ? '<br><p>Go back to <a href="'+ errorRedirectUrl +'">'+ errorRedirectUrl +'</a></p>' : '' }
          `,
        },
        isSuccess: false,
      });
    }
  },

  /**
   * Form submission handler to OAuth Client authorizations.
   *
   * This function supports the user-facing function by handling all the form
   * submissions.
   *
   *   - If ALLOW, the OAuth Client is added to their profile, and they redirect
   *     to the original website.
   *   - If DENY, the process halts and they get redirected to their HID dashboard.
   */
  async authorizeOauth2(request, reply) {
    try {
      const oauth = request.server.plugins['hapi-oauth2orize'];
      const cookie = request.yar.get('session');

      // Force users without existing sessions to log in.
      if (!cookie || (cookie && !cookie.userId) || (cookie && !cookie.totp)) {
        logger.info(
          '[AuthController->authorizeOauth2] Got request to /oauth/authorize without session. Redirecting to the login page.',
          {
            request,
            oauth: {
              client_id: request.query.client_id,
              redirect_uri: request.query.redirect_uri,
              response_type: request.query.response_type,
            },
          },
        );
        return reply.redirect(
          `/?redirect=/oauth/authorize&client_id=${request.query.client_id
          }&redirect_uri=${request.query.redirect_uri
          }&response_type=${request.query.response_type
          }&state=${request.query.state
          }&scope=${request.query.scope
          }&nonce=${request.query.nonce
          }#login`);
      }

      // Look up user in DB.
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
              redirect_uri: request.query.redirect_uri,
              response_type: request.query.response_type,
            },
          },
        );
        throw Boom.badRequest('Could not find user');
      }
      user.sanitize(user);
      request.auth.credentials = user;

      // Set up OAuth Client to potentially be stored on user profile.
      const clientMongoId = request.yar.authorize[request.payload.transaction_id].client;
      const clientId = request.yar.authorize[request.payload.transaction_id].req.clientID;

      // If user clicked 'Deny', redirect to HID homepage.
      if (!request.payload.bsubmit || request.payload.bsubmit === 'Deny') {
        return reply.redirect('/');
      }

      // If the user clicked 'Allow', save OAuth Client to user profile
      if (!user.hasAuthorizedClient(clientMongoId) && request.payload.bsubmit === 'Allow') {
        // TODO: we could store an array of objects including the current time
        //       when adding the client, in order to offer security-related info
        //       when the user views their OAuth settings.
        //
        // @see HID-2156
        user.authorizedClients.push(clientMongoId);
        user.markModified('authorizedClients');
        await user.save();

        logger.info(
          '[AuthController->authorizeOauth2] Added OAuth Client to user profile',
          {
            request,
            security: true,
            user: {
              id: user.id,
              email: user.email,
            },
            oauth: {
              client_id: clientId,
            },
          },
        );
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

  /**
   * Issues an access_token during "Extra Secure" OAuth flows.
   *
   * @see https://github.com/UN-OCHA/hid_api/wiki/Integrating-with-HID-via-OAuth#step-2--request-access-and-id-tokens
   */
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
        return Boom.unauthorized('Missing authorization code');
      }

      // Check client_id and client_secret
      let client = null;
      let clientId = null;
      let clientSecret = null;

      // Are we using POST body authorization?
      if (request.payload.client_id && request.payload.client_secret) {
        clientId = request.payload.client_id;
        clientSecret = request.payload.client_secret;
      }
      // Are we using Basic Auth?
      else if (request.headers.authorization) {
        const parts = request.headers.authorization.split(' ');
        if (parts.length === 2) {
          const credentials = parts[1];
          const buff = Buffer.from(credentials, 'base64');
          const text = buff.toString('ascii');
          const cparts = text.split(':');
          [clientId, clientSecret] = cparts;
        }
      }
      // Neither authorization method found. Log it.
      else {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to invalid client authentication.',
          {
            request,
            security: true,
            fail: true,
          },
        );
        return Boom.unauthorized('invalid client authentication');
      }

      // Look up OAuth Client in DB.
      client = await Client.findOne({ id: clientId });
      if (!client) {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to non-existent client ID.',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: clientId,
            },
          },
        );
        return Boom.badRequest('invalid client_id');
      }

      // Does the client_secret we received match the DB entry?
      if (clientSecret !== client.secret) {
        logger.warn(
          '[AuthController->accessTokenOAuth2] Unsuccessful access token request due to wrong client authentication.',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: clientId,
              client_secret: `${clientSecret.slice(0, 3)}...${clientSecret.slice(-3)}`,
            },
          },
        );
        return Boom.unauthorized('invalid client_secret');
      }

      // Grab token and type.
      const token = request.payload.code ? request.payload.code : request.payload.refresh_token;
      const type = request.payload.code ? 'code' : 'refresh';

      // Find authorization code.
      const ocode = await OauthToken.findOne({ token, type }).populate('client user');
      if (!ocode) {
        logger.warn(
          '[AuthController->accessTokenOauth2] Unsuccessful access token request due to wrong authorization code.',
          {
            request,
            security: true,
            fail: true,
            oauth: {
              client_id: clientId,
              token: `${token.slice(0, 3)}...${token.slice(-3)}`,
              type,
            },
          },
        );

        // OAuth2 standard error.
        const error = Boom.badRequest('invalid authorization code');
        error.output.payload.error = 'invalid_grant';
        return error;
      } else {
        logger.info(
          '[AuthController->accessTokenOauth2] Successful access token request',
          {
            request,
            security: true,
            oauth: {
              client_id: clientId,
              client_secret: `${clientSecret.slice(0, 3)}...${clientSecret.slice(-3)}`,
            },
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

      // Send a documented error code back.
      return Boom.badRequest(err.message);
    }
  },

  /**
   * Returns our supported OpenID Connect configuration so that a client can
   * be aware of certain properties, scopes, and other attributes supported by
   * the HID implementation.
   */
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
      scopes_supported: ['openid', 'email', 'profile'],
      claims_supported: [
        'iss',
        'sub',
        'name',
        'family_name',
        'given_name',
        'email',
        'email_verified',
        'user_id',
      ],
    };
    return out;
  },

  /**
   * Serve a user's identity for OpenID Connect.
   *
   * This shouldn't be used for anything else when working with API. If you do
   * want more info about the user, use the dedicated API method:
   *
   * @see /api/v3/user/{id}
   * @see UserController.find()
   */
  showAccount(request) {
    // Full user object from DB.
    const user = JSON.parse(JSON.stringify(request.auth.credentials));

    // This will be what we send back as a response.
    const output = {
      id: user.id,
      sub: user.id,
      email: user.email,
      email_verified: user.email_verified.toString(),
      name: user.name,
      family_name: user.family_name,
      given_name: user.given_name,
      iss: process.env.ROOT_URL || 'https://auth.humanitarian.id',
      user_id: user.user_id,
    };

    // Log the request
    logger.info(
      `[AuthController->showAccount] calling /account.json for ${request.auth.credentials.email}`,
      {
        request,
        user: {
          id: request.auth.credentials.id,
          email: request.auth.credentials.email,
          admin: request.auth.credentials.is_admin,
        },
        oauth: {
          client_id: request.params.currentClient && request.params.currentClient.id,
        },
      },
    );

    // Special cases for legacy compat.
    //
    // @TODO: in testing this, it seems that the `currentClient` param is not
    //        present when this function runs. Investigate whether we need these
    //        special cases at all.
    //
    //        @see https://humanitarian.atlassian.net/browse/HID-2192
    if (request.params.currentClient && (request.params.currentClient.id === 'iasc-prod' || request.params.currentClient.id === 'iasc-dev')) {
      output.sub = user.email;
    }
    if (request.params.currentClient && request.params.currentClient.id === 'kaya-prod') {
      output.name = user.name.replace(' ', '');
    }
    if (request.params.currentClient
      && (request.params.currentClient.id === 'rc-shelter-database'
        || request.params.currentClient.id === 'rc-shelter-db-2-prod'
        || request.params.currentClient.id === 'deep-prod')) {
      output.active = !user.deleted;
    }

    // Send response
    return output;
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
          user: {
            id: request.auth.credentials.id,
            email: request.auth.credentials.email,
          },
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
        user: {
          id: request.auth.credentials.id,
          email: request.auth.credentials.email,
        },
      },
    );
    throw Boom.forbidden('Could not blacklist this token because you did not generate it');
  },
};
