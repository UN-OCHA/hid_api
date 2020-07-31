const Boom = require('@hapi/boom');
const Recaptcha = require('recaptcha2');
const Client = require('../models/Client');
const User = require('../models/User');
const HelperService = require('../services/HelperService');
const UserController = require('./UserController');
const AuthPolicy = require('../policies/AuthPolicy');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

function _getRegisterLink(args) {
  const params = HelperService.getOauthParams(args);
  let registerLink = '/register';
  if (params) {
    registerLink += `?${params}`;
  }
  return registerLink;
}

function _getPasswordLink(args) {
  const params = HelperService.getOauthParams(args);
  let registerLink = '/password';
  if (params) {
    registerLink += `?${params}`;
  }
  return registerLink;
}

function _buildRequestUrl(request, url) {
  let requestUrl = `https://${request.info.host}/${url}`;
  if (request.query.client_id) {
    requestUrl += `?client_id=${request.query.client_id}`;
  }
  if (request.query.redirect_uri) {
    requestUrl += `&redirect_uri=${request.query.redirect_uri}`;
  }
  if (request.query.response_type) {
    requestUrl += `&response_type=${request.query.response_type}`;
  }
  if (request.query.scope) {
    requestUrl += `&scope=${request.query.scope}`;
  }
  return requestUrl;
}

module.exports = {

  async login(request, reply) {
    const cookie = request.yar.get('session');

    if (cookie && cookie.userId && cookie.totp === true) { // User is already logged in
      if (request.query.client_id
        && request.query.redirect_uri
        && request.query.response_type
        && request.query.scope) {
        // Redirect to /oauth/authorize
        let redirect = request.query.redirect || '/oauth/authorize';
        redirect += `?client_id=${request.query.client_id}`;
        redirect += `&redirect_uri=${request.query.redirect_uri}`;
        redirect += `&response_type=${request.query.response_type}`;
        if (request.query.state) {
          redirect += `&state=${request.query.state}`;
        }
        redirect += `&scope=${request.query.scope}`;

        return reply.redirect(redirect);
      }
      // User is already logged in
      return reply.redirect('/user');
    }

    if (cookie && cookie.userId && cookie.totp === false) {
      // Show TOTP form
      return reply.view('totp', {
        title: 'Enter your Authentication code',
        query: request.query,
        destination: '/login',
        alert: false,
      });
    }

    // Show the login form
    const registerLink = _getRegisterLink(request.query);
    const passwordLink = _getPasswordLink(request.query);
    const loginArgs = {
      title: 'Log into Humanitarian ID',
      query: request.query,
      registerLink,
      passwordLink,
      alert: false,
    };

    // Check client ID and redirect URI at this stage, so we can send an error message if needed.
    if (request.query.client_id) {
      try {
        const client = await Client.findOne({ id: request.query.client_id });
        if (!client
          || (client && client.redirectUri !== request.query.redirect_uri
            && !client.redirectUrls.includes(request.query.redirect_uri))) {
          loginArgs.alert = {
            type: 'danger',
            message: 'The configuration of the client application is invalid. We can not log you in.',
          };
          return reply.view('login', loginArgs);
        }
        return reply.view('login', loginArgs);
      } catch (err) {
        loginArgs.alert = {
          type: 'danger',
          message: 'Internal server error. We can not log you in. Please let us know at info@humanitarian.id',
        };
        return reply.view('login', loginArgs);
      }
    } else {
      return reply.view('login', loginArgs);
    }
  },

  async logout(request, reply) {
    request.yar.reset();
    if (request.query.redirect) {
      // Validate redirect URL
      const url = request.query.redirect;
      const urlArray = url.split('/');
      let hostname;
      if (url.indexOf('://') > -1) {
        [, , hostname] = urlArray;
      } else {
        [hostname] = urlArray;
      }
      // find & remove port number
      [hostname] = hostname.split(':');
      // find & remove "?"
      [hostname] = hostname.split('?');
      const regex = new RegExp(hostname, 'i');
      try {
        const count = await Client.countDocuments({ redirectUri: regex });
        if (count > 0) {
          return reply.redirect(request.query.redirect);
        }
        logger.warn(`Redirecting to ${request.query.redirect} is not allowed`, { security: true, fail: true, request });
        return reply.redirect('/');
      } catch (err) {
        logger.error(
          'Error logging user out',
          {
            request,
            security: true,
            fail: true,
            error: err.message,
            err_object: err,
            stack_trace: err.stack,
          },
        );
        return reply.redirect('/');
      }
    } else {
      return reply.redirect('/');
    }
  },

  register(request, reply) {
    const requestUrl = _buildRequestUrl(request, 'verify2');
    return reply.view('register', {
      title: 'Register a Humanitarian ID account',
      requestUrl,
      recaptcha_site_key: process.env.RECAPTCHA_PUBLIC_KEY,
    });
  },

  async registerPost(request, reply) {
    // Check recaptcha
    const recaptcha = new Recaptcha({
      siteKey: process.env.RECAPTCHA_PUBLIC_KEY,
      secretKey: process.env.RECAPTCHA_PRIVATE_KEY,
    });
    const registerLink = _getRegisterLink(request.payload);
    const passwordLink = _getPasswordLink(request.payload);
    try {
      await recaptcha.validate(request.payload['g-recaptcha-response']);
    } catch (err) {
      return reply.view('login', {
        alert: { type: 'danger', message: recaptcha.translateErrors(err) },
        query: request.query,
        registerLink,
        passwordLink,
      });
    }
    try {
      await UserController.create(request);
      return reply.view('login', {
        alert: { type: 'success', message: 'Thank you for creating an account. You will soon receive a confirmation email to confirm your account.' },
        query: request.query,
        registerLink,
        passwordLink,
      });
    } catch (err) {
      return reply.view('login', {
        alert: { type: 'danger', message: 'There is an error in your registration. You may have already registered. If so, simply reset your password at https://auth.humanitarian.id/password.' },
        query: request.query,
        registerLink,
        passwordLink,
      });
    }
  },

  async verify(request, reply) {
    if (!request.query.hash && !request.query.id && !request.query.time) {
      throw Boom.badRequest('Missing hash parameter');
    }
    request.payload = {
      hash: request.query.hash,
      id: request.query.id,
      time: request.query.time,
    };
    const registerLink = _getRegisterLink(request.query);
    const passwordLink = _getPasswordLink(request.query);
    try {
      await UserController.validateEmail(request);
      return reply.view('login', {
        alert: { type: 'success', message: 'Thank you for confirming your email address. You can now log in' },
        query: request.query,
        registerLink,
        passwordLink,
      });
    } catch (err) {
      return reply.view('login', {
        alert: { type: 'danger', message: 'There was an error confirming your email address.' },
        query: request.query,
        registerLink,
        passwordLink,
      });
    }
  },

  password(request, reply) {
    const requestUrl = _buildRequestUrl(request, 'new_password');
    return reply.view('password', {
      requestUrl,
    });
  },

  async passwordPost(request, reply) {
    const registerLink = _getRegisterLink(request.payload);
    const passwordLink = _getPasswordLink(request.payload);
    try {
      await UserController.resetPasswordEndpoint(request);
      return reply.view('login', {
        alert: { type: 'success', message: `Password reset was sent to ${request.payload.email}. Please make sure the email address is correct. If not, please reset your password again.` },
        query: request.query,
        registerLink,
        passwordLink,
      });
    } catch (err) {
      return reply.view('login', {
        alert: { type: 'danger', message: 'There was an error resetting your password.' },
        query: request.query,
        registerLink,
        passwordLink,
      });
    }
  },

  async newPassword(request, reply) {
    request.yar.reset();
    request.yar.set('session', {
      hash: request.query.hash, id: request.query.id, time: request.query.time, totp: false,
    });
    const user = await User.findOne({ _id: request.query.id });
    if (!user) {
      return reply.view('error');
    }
    if (user.totp) {
      return reply.view('totp', {
        query: request.query,
        destination: '/new_password',
        alert: false,
      });
    }
    request.yar.set('session', {
      hash: request.query.hash, id: request.query.id, time: request.query.time, totp: true,
    });
    return reply.view('new_password', {
      query: request.query,
      hash: request.query.hash,
      id: request.query.id,
      time: request.query.time,
    });
  },

  async newPasswordPost(request, reply) {
    const cookie = request.yar.get('session');

    if (cookie && cookie.hash && cookie.id && cookie.time && !cookie.totp) {
      try {
        const user = await User.findOne({ _id: cookie.id });
        const token = request.payload['x-hid-totp'];
        await AuthPolicy.isTOTPValid(user, token);
        cookie.totp = true;
        request.yar.set('session', cookie);
        return reply.view('new_password', {
          query: request.payload,
          hash: cookie.hash,
          id: cookie.id,
          time: cookie.time,
        });
      } catch (err) {
        const alert = {
          type: 'danger',
          message: err.output.payload.message,
        };
        return reply.view('totp', {
          query: request.payload,
          destination: '/new_password',
          alert,
        });
      }
    }

    if (cookie && cookie.hash && cookie.totp) {
      const params = HelperService.getOauthParams(request.payload);
      const registerLink = _getRegisterLink(request.payload);
      const passwordLink = _getPasswordLink(request.payload);
      try {
        await UserController.resetPasswordEndpoint(request);
        if (params) {
          return reply.view('login', {
            alert: { type: 'success', message: 'Your password was successfully reset. You can now login.' },
            query: request.payload,
            registerLink,
            passwordLink,
          });
        }
        return reply.view('message', {
          alert: { type: 'success', message: 'Thank you for updating your password.' },
          query: request.payload,
          isSuccess: true,
          title: 'Password update',
        });
      } catch (err) {
        if (params) {
          return reply.view('login', {
            alert: { type: 'danger', message: 'There was an error resetting your password.' },
            query: request.payload,
            registerLink,
            passwordLink,
          });
        }
        return reply.view('message', {
          alert: { type: 'danger', message: 'There was an error resetting your password.' },
          query: request.payload,
          isSuccess: false,
          title: 'Password update',
        });
      }
    }

    return reply.view('message', {
      alert: { type: 'danger', message: 'There was an error resetting your password.' },
      query: request.payload,
      isSuccess: false,
      title: 'Password update',
    });
  },

  // Display a default user page when user is logged in without OAuth
  async user(request, reply) {
    // If the user is not authenticated, redirect to the login page
    const cookie = request.yar.get('session');
    if (!cookie || (cookie && !cookie.userId) || (cookie && !cookie.totp)) {
      return reply.redirect('/');
    }
    const user = await User.findOne({ _id: cookie.userId });
    return reply.view('user', {
      user,
    });
  },
};
