'use strict';

const Model = require('trails-model');
const Schema = require('mongoose').Schema;
const Bcrypt = require('bcryptjs');
const Libphonenumber = require('google-libphonenumber');
const Http = require('http');
const https = require('https');
const async = require('async');
const deepPopulate = require('mongoose-deep-populate')(require('mongoose'));
const listTypes = ['operation', 'bundle', 'disaster', 'organization'];
const userPopulate = 'favoriteLists operations.list disasters.list bundles.list organization.list organizations.list lists.list authorizedClients verified_by';

/**
 * @module User
 * @description User
 */
module.exports = class User extends Model {

  static config () {
    return {
      schema: {
        timestamps: true,
        toObject: {
          virtuals: true
        },
        toJSON: {
          virtuals: true
        }
      },
      statics: {
        hashPassword: function (password) {
          return Bcrypt.hashSync(password, 11);
        },
        explodeHash: function (hashLink) {
          const key = new Buffer(hashLink, 'base64').toString('ascii');
          const parts = key.split('/');
          return {
            'email': parts[0],
            'timestamp': parts[1],
            'hash': new Buffer(parts[2], 'base64').toString('ascii')
          };
        }
      },
      methods: {
        sanitize: function () {
          this.sanitizeClients();
        },
        getAppUrl: function () {
          return process.env.APP_URL + '/users/' + this._id;
        },
        sanitizeClients: function () {
          if (this.authorizedClients && this.authorizedClients.length) {
            var sanitized = [];
            for (var i = 0, len = this.authorizedClients.length; i < len; i++) {
              if (this.authorizedClients[i].secret) {
                sanitized.push({
                  id: this.authorizedClients[i].id,
                  name: this.authorizedClients[i].name
                });
              }
              else {
                sanitized.push(this.authorizedClients[i]);
              }
            }
          }
        },
        validPassword: function (password)  {
          return Bcrypt.compareSync(password, this.password);
        },

        generateHash: function (email) {
          const now = Date.now();
          const hash = new Buffer(Bcrypt.hashSync(this.password + now + this._id, 11)).toString('base64');
          return new Buffer(email + '/' + now + '/' + hash).toString('base64');
        },

        // Validate the hash of a confirmation link
        validHash: function (hashLink) {
          const key = new Buffer(hashLink, 'base64').toString('ascii');
          const parts = key.split('/');
          const email = parts[0];
          const timestamp = parts[1];
          const hash = new Buffer(parts[2], 'base64').toString('ascii');
          const now = Date.now();

          // Verify hash
          // verify timestamp is not too old (allow up to 7 days in milliseconds)
          if (timestamp < (now - 7 * 86400000) || timestamp > now) {
            return 'Expired confirmation link';
          }

          if (this.emailIndex(email) === -1) {
            return 'Wrong user or wrong email in the hash';
          }

          // verify hash
          if (!Bcrypt.compareSync(this.password + timestamp + this._id, hash)) {
            return 'This verification link has already been used';
          }
          return true;
        },

        emailIndex: function (email) {
          var index = -1;
          for (var i = 0, len = this.emails.length; i < len; i++) {
            if (this.emails[i].email === email) {
              index = i;
            }
          }
          return index;
        },

        hasAuthorizedClient: function (clientId) {
          var out = false;
          for (var i = 0, len = this.authorizedClients.length; i < len; i++) {
            if (this.authorizedClients[i].id === clientId) {
              out = true;
            }
          }
          return out;
        },

        // Whether we should send a reminder to verify email to user
        // Reminder emails are sent out 2, 4, 7 and 30 days after registration
        shouldSendReminderVerify: function() {
          const created = new Date(this.createdAt),
            current = Date.now(),
            remindedVerify = new Date(this.remindedVerify);
          if (this.email_verified) {
            return false;
          }
          if (!this.remindedVerify && !this.timesRemindedVerify && current.valueOf() - created.valueOf() > 48 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 1 && current.valueOf() - remindedVerify.valueOf() > 48 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 2 && current.valueOf() - remindedVerify.valueOf() > 72 * 3600 * 1000) {
            return true;
          }
          if (this.remindedVerify && this.timesRemindedVerify === 3 && current.valueOf() - remindedVerify.valueOf() > 23 * 24 * 3600 * 1000) {
            return true;
          }
          return false;
        },

        // Whether we should send an update reminder (sent out after a user hasn't been updated for 6 months)
        shouldSendReminderUpdate: function () {
          var d = new Date();
          var revisedOffset = d.valueOf();
          revisedOffset = d.valueOf() - this.updatedAt.valueOf();
          if (revisedOffset < 183 * 24 * 3600 * 1000) { // if not revised during 6 months
            return false;
          }
          if (this.remindedUpdate) {
            var remindedOffset = d.valueOf() - this.remindedUpdate.valueOf();
            if (remindedOffset < 183 * 24 * 3600 * 1000) {
              return false;
            }
          }
          return true;
        },

        hasLocalPhoneNumber: function (iso2) {
          var found = false,
            that = this;
          this.phone_numbers.forEach(function (item) {
            const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
            try {
              var phoneNumber = phoneUtil.parse(item.number);
              var regionCode = phoneUtil.getRegionCodeForNumber(phoneNumber);
              if (regionCode.toUpperCase() === iso2) {
                found = true;
              }
            }
            catch (err) {
              // Invalid phone number
              that.log.error(err);
            }
          });
          return found;
        },

        // Whether the contact is in country or not
        isInCountry: function (pcode, callback) {
          var hrinfoId = this.location.country.id.replace('hrinfo_loc_', '');
          var path = '/api/v1.0/locations/' + hrinfoId,
            that = this;
          https.get({
            host: 'www.humanitarianresponse.info',
            port: 443,
            path: path
          }, function (response) {
            var body = '';
            response.on('data', function (d) {
              body += d;
            });
            response.on('end', function() {
              var parsed = {};
              try {
                parsed = JSON.parse(body);
                if (parsed.data[0].pcode === pcode) {
                  return callback(null, true);
                }
                else {
                  return callback(null, false);
                }
              } catch (e) {
                that.log.info('Error parsing hrinfo API: ' + e);
                return callback(e);
              }
            });
          });
        },

        toJSON: function () {
          const user = this.toObject();
          delete user.password;
          return user;
        }
      }
    };
  }

  static schema () {

    const emailSchema = new Schema({
      type: {
        type: String,
        enum: ['Work', 'Personal']
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
        unique: true,
        match: /^([\w-\.]+@([\w-]+\.)+[\w-]{2,4})?$/
      },
      validated: {
        type: Boolean,
        default: false
      }
    }, { readonly: true });

    const phoneSchema = new Schema({
      type: {
        type: String,
        enum: ['Landline', 'Mobile']
      },
      number: {
        type: String,
        validate: {
          validator: function (v) {
            if (v !== '') {
              try {
                const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
                const phone = phoneUtil.parse(v);
                return phoneUtil.isValidNumber(phone);
              }
              catch (e) {
                return false;
              }
            }
            else {
              return true;
            }
          },
          message: '{VALUE} is not a valid phone number !'
        }
      },
      validated: {
        type: Boolean,
        default: false
      }
    });

    return {
      // Legacy user_id data, to be added during migration
      user_id: {
        type: String,
        readonly: true
      },
      given_name: {
        type: String,
        trim: true,
        required: [true, 'Given name is required']
      },
      middle_name: {
        type: String,
        trim: true
      },
      family_name: {
        type: String,
        trim: true,
        required: [true, 'Family name is required']
      },
      name: {
        type: String
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
        unique: true,
        match: /^([\w-\.]+@([\w-]+\.)+[\w-]{2,4})?$/
      },
      email_verified: {
        type: Boolean,
        default: false,
        readonly: true
      },
      // Last time the user was reminded to verify his account
      remindedVerify: {
        type: Date,
        readonly: true
      },
      // How many times the user was reminded to verify his account
      timesRemindedVerify: {
        type: Number,
        default: 0,
        readonly: true
      },
      // Last time the user was reminded to update his account details
      remindedUpdate: {
        type: Date,
        readonly: true
      },
      // TODO: find a way to set this as readonly
      emails: [emailSchema],
      password: {
        type: String
      },
      // Only admins can set this
      verified: {
        type: Boolean,
        default: false,
        adminOnly: true
      },
      verified_by: {
        type: Schema.ObjectId,
        ref: 'User',
        readonly: true
      },
      // Makes sure it's a valid URL
      picture: {
        type: String,
        match: /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/
      },
      notes: {
        type: String
      },
      // Validates an array of VoIP objects
      voips: {
        type: Array,
        validate: {
          validator: function (v) {
            if (v.length) {
              var out = true, types = ['Skype', 'Google'];
              for (var i = 0, len = v.length; i < len; i++) {
                if (!v[i].username || !v[i].type || (v[i].type && types.indexOf(v[i].type) === -1)) {
                  out = false;
                }
              }
              return out;
            }
            else {
              return true;
            }
          },
          message: 'Invalid voip found'
        }
      },
      // Validates urls
      websites: {
        type: Array,
        validate: {
          validator: function (v) {
            if (v.length) {
              var out = true;
              var urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/;
              for (var i = 0, len = v.length; i < len; i++) {
                if (!urlRegex.test(v[i].url)) {
                  out = false;
                }
              }
              return out;
            }
            else {
              return true;
            }
          },
          message: 'There is an invalid url'
        }
      },
      // TODO: validate timezone
      zoneinfo: {
        type: String
      },
      locale: {
        type: String,
        enum: ['en', 'fr']
      },
      // TODO :make sure it's a valid organization
      organization: {
        type: Schema.ObjectId,
        ref: 'ListUser'
      },
      organizations: [{
        type: Schema.ObjectId,
        ref: 'ListUser'
      }],
      // Verify valid phone number with libphonenumber and reformat if needed
      phone_number: {
        type: String,
        validate: {
          validator: function (v) {
            if (v !== '') {
              try {
                const phoneUtil = Libphonenumber.PhoneNumberUtil.getInstance();
                const phone = phoneUtil.parse(v);
                return phoneUtil.isValidNumber(phone);
              } catch (e) {
                return false;
              }
            }
            else {
              return true;
            }
          },
          message: '{VALUE} is not a valid phone number !'
        }
      },
      phone_number_type: {
        type: String,
        enum: ['Mobile', 'Landline'],
      },
      // TODO: find a way to set this as readonly
      phone_numbers: [phoneSchema],
      job_title: {
        type: String
      },
      job_titles: {
        type: Array
      },
      // TODO: Verifies that roles belong to hrinfo functional roles
      roles: {
        type: Array,
        adminOnly: true,
        validate: {
          validator: function (v) {
            if (v.length) {
              var out = true;
              for (var i = 0, len = v.length; i < len; i++) {
                if (!v[i].id || !v[i].label || !v[i].self) {
                  out = false;
                }
              }
              return out;
            }
            else {
              return true;
            }
          },
          message: 'Invalid role found'
        }
      },
      status: {
        type: String
      },
      // TODO: make sure this is a valid location
      location: {
        type: Schema.Types.Mixed
      },
      locations: {
        type: Array
      },
      // Only an admin can set this
      is_admin: {
        type: Boolean,
        default: false,
        adminOnly: true
      },
      is_orphan: {
        type: Boolean,
        default: false,
        readonly: true
      },
      is_ghost: {
        type: Boolean,
        default: false,
        readonly: true
      },
      expires: {
        type: Date,
        default: +new Date() + 7*24*60*60*1000,
        readonly: true
      },
      lastLogin: {
        type: Date,
        readonly: true
      },
      createdBy: {
        type: Schema.ObjectId,
        ref: 'User',
        readonly: true
      },
      favoriteLists: [{
        type: Schema.ObjectId,
        ref: 'List'
      }],
      lists: [{
        type: Schema.ObjectId,
        ref: 'ListUser'
      }],
      operations: [{
        type: Schema.ObjectId,
        ref: 'ListUser'
      }],
      bundles: [{
        type: Schema.ObjectId,
        ref: 'ListUser'
      }],
      disasters: [{
        type: Schema.ObjectId,
        ref: 'ListUser'
      }],
      authorizedClients: [{
        type: Schema.ObjectId,
        ref: 'Client'
      }],
      deleted: {
        type: Boolean,
        default: false
      }
    };
  }

  static onSchema(schema) {
    schema.plugin(deepPopulate, {});
    schema.virtual('sub').get(function () {
      return this._id;
    });
    schema.pre('save', function (next) {
      if (this.middle_name) {
        this.name = this.given_name + ' ' + this.middle_name + ' ' + this.family_name;
      }
      else {
        this.name = this.given_name + ' ' + this.family_name;
      }
      if (!this.email) {
        this.is_ghost = true;
      }
      else {
        this.is_ghost = false;
      }
      if (this.createdBy && !this.email_verified && this.email) {
        this.is_orphan = true;
      }
      else {
        this.is_orphan = false;
      }
      next ();
    });
    schema.pre('update', function (next) {
      let name, that;
      that = this;
      this.findOne(function (err, user) {
        if (user.middle_name) {
          name = user.given_name + ' ' + user.middle_name + ' ' + user.family_name
        }
        else {
          name = user.given_name + ' ' + user.family_name
        }
        that.findOneAndUpdate({name: name});
        next();
      });
    });
    // Populate lists
    schema.post('findOne', function (result, next) {
      let that = this;
      if (!result) {
        return next();
      }
      result
        .deepPopulate(userPopulate)
        .then(user => {
          next();
        })
        .catch(err => that.log.error(err));
    });
    schema.post('find', function (results, next) {
      let that = this;
      async.eachOf(results, function (result, key, cb) {
        results[key]
          .deepPopulate(userPopulate)
          .then((r) => {
            cb();
          });
      }, function (err) {
        next();
      });
    });
  }
};
