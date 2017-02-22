'use strict';

const Controller = require('trails/controller');
const Boom = require('boom');
const _ = require('lodash');
const async = require('async');
const acceptLanguage = require('accept-language');

/**
 * @module ListController
 * @description Generated Trails.js Controller.
 */
module.exports = class ListController extends Controller{

  _removeForbiddenAttributes (request) {
    var forbiddenAttributes = [];
    if (!request.params.currentUser || !request.params.currentUser.is_admin) {
      forbiddenAttributes = forbiddenAttributes.concat(
        this.app.services.HelperService.getReadonlyAttributes('List', ['names']),
        this.app.services.HelperService.getAdminOnlyAttributes('List')
      );
    }
    else {
      forbiddenAttributes = forbiddenAttributes.concat(this.app.services.HelperService.getReadonlyAttributes('List', ['names']));
    }
    // Do not allow forbiddenAttributes to be updated directly
    for (var i = 0, len = forbiddenAttributes.length; i < len; i++) {
      if (request.payload[forbiddenAttributes[i]]) {
        delete request.payload[forbiddenAttributes[i]];
      }
    }
  }

  create (request, reply) {
    const List = this.app.orm.List;
    this._removeForbiddenAttributes(request);
    request.payload.owner = request.params.currentUser._id;
    if (!request.payload.managers) {
      request.payload.managers = [];
    }
    request.payload.managers.push(request.params.currentUser._id);
    let that = this;
    List
      .create(request.payload)
      .then((list) => {
        return reply(list);
      })
      .catch(err => {
        that.app.services.ErrorService.handle(err, reply);
      });
  }

  find (request, reply) {
    const reqLanguage = acceptLanguage.get(request.headers['accept-language']);
    const options = this.app.services.HelperService.getOptionsFromQuery(request.query);
    const criteria = this.app.services.HelperService.getCriteriaFromQuery(request.query);
    const List = this.app.orm.List;
    const User = this.app.orm.User;
    let response;

    if (!options.sort) {
      options.sort = 'name';
    }

    // Search with contains when searching in name or label
    if (criteria.name) {
      var name = criteria.name.replace(/\(|\\|\^|\.|\||\?|\*|\+|\)|\[|\{/, '');
      name = new RegExp(name, 'i');
      criteria['names.text'] = name;
      delete criteria.name;
    }
    if (criteria.label) {
      criteria.label = criteria.label.replace(/\(|\\|\^|\.|\||\?|\*|\+|\)|\[|\{/, '');
      criteria.label = new RegExp(criteria.label, 'i');
    }

    // Do not show deleted lists
    criteria.deleted = {$in: [false, null]};

    this.log.debug('[ListController] (find) model = list, criteria =', request.query, request.params.id, 'options =', options);

    var findCallback = function (result) {
      if (!result) {
        return Boom.notFound();
      }
      return result;
    };

    // List visiblity
    var currentUser = request.params.currentUser,
      that = this;

    if (request.params.id) {
      if (!options.populate) {
        options.populate = [{path: 'owner', select: '_id name'}, {path: 'managers', select: '_id name'}];
      }
      List
        .findOne({_id: request.params.id, deleted: criteria.deleted })
        .populate(options.populate)
        .then(result => {
          if (!result) {
            throw Boom.notFound();
          }

          var out = result.toJSON();
          out.name = result.translatedAttribute('names', reqLanguage);
          out.acronym = result.translatedAttribute('acronyms', reqLanguage);
          out.visible = result.isVisibleTo(request.params.currentUser);
          return reply(out);
        })
        .catch(err => { that.app.services.ErrorService.handle(err, reply); });
    }
    else {
      options.populate = [{path: 'owner', select: '_id name'}];
      const query = this.app.services.HelperService.find('List', criteria, options);
      query
        .then((results) => {
          return List
            .count(criteria)
            .then((number) => {
              return {result: results, number: number};
            });
        })
        .then((result) => {
          const out = [];
          let tmp = {};
          let optionsArray = [];
          if (options.fields) {
            optionsArray = options.fields.split(' ');
          }
          async.eachSeries(result.result, function (list, next) {
            tmp = list.toJSON();
            tmp.visible = list.isVisibleTo(request.params.currentUser);
            tmp.name = list.translatedAttribute('names', reqLanguage);
            tmp.acronym = list.translatedAttribute('acronyms', reqLanguage);
            if (optionsArray.indexOf('count') !== -1) {
              let ucriteria = {};
              ucriteria[list.type + 's'] = {$elemMatch: {list: list._id, deleted: false, pending: false}};
              User
                .count(ucriteria)
                .then((count) => {
                  tmp.count = count;
                  out.push(tmp);
                  next();
                });
            }
            else {
              out.push(tmp);
              next();
            }
          }, function (err) {
            reply(out).header('X-Total-Count', result.number);
          });
        })
        .catch((err) => {
          that.app.services.ErrorService.handle(err, reply);
        });
    }
  }

  _notifyManagers(uids, type, request, list) {
    const User = this.app.orm.user;
    var that = this;
    User
      .find({_id: {$in: uids}})
      .exec()
      .then((users) => {
        for (var i = 0, len = users.length; i < len; i++) {
          that.app.services.NotificationService
            .send({type: type, user: users[i], createdBy: request.params.currentUser, params: { list: list } }, () => {});
        }
      })
      .catch((err) => { that.log.error(err); });
  }

  update (request, reply) {
    const FootprintService = this.app.services.FootprintService;
    const options = this.app.services.HelperService.getOptionsFromQuery(request.query);
    const criteria = this.app.services.HelperService.getCriteriaFromQuery(request.query);
    const Model = this.app.orm.list;
    const User = this.app.orm.user;

    this._removeForbiddenAttributes(request);

    if (!options.populate) {
      options.populate = 'owner managers';
    }

    this.log.debug('[ListController] (update) model = list, criteria =', request.query, request.params.id, ', values = ', request.payload);

    var that = this;
    Model
      .findOne({_id: request.params.id})
      .then(list => {
        var oldlist = _.clone(list);
        _.merge(list, request.payload);
        return list
          .save()
          .then(() => {
            reply(list);
            return oldlist;
          });
      })
      .then((list) => {
        var payloadManagers = [];
        if (request.payload.managers) {
          request.payload.managers.forEach(function (man) {
            if (man._id) {
              payloadManagers.push(man._id.toString());
            }
            else {
              payloadManagers.push(man);
            }
          });
        }
        var listManagers = [];
        if (list.managers) {
          list.managers.forEach(function (man) {
            listManagers.push(man._id.toString());
          });
        }
        var diffAdded = _.difference(payloadManagers, listManagers);
        var diffRemoved = _.difference(listManagers, payloadManagers);
        if (diffAdded.length) {
          that._notifyManagers(diffAdded, 'added_list_manager', request, list);
        }
        if (diffRemoved.length) {
          that._notifyManagers(diffRemoved, 'removed_list_manager', request, list);
        }
        return list;
      })
      .then(list => {
        return Model
          .find({_id: request.params.id})
          .then(newlist => {
            return newlist;
          });
      })
      .then(list => {
        // Update users
        var criteria = {};
        criteria[list.type + 's.list'] = list._id.toString();
        return User
          .find(criteria)
          .then(users => {
            for (var i = 0; i < users.length; i++) {
              var user = users[i];
              for (var j = 0; j < user[list.type + 's'].length; j++) {
                if (user[list.type + 's'][j].list === list._id) {
                  user[list.type + 's'][j].name = list.name;
                  user[list.type + 's'][j].names = list.names;
                  user[list.type + 's'][j].acronym = list.acronym;
                  user[list.type + 's'][j].acronyms = list.acronyms;
                  user[list.type + 's'][j].visibility = list.visibility;
                }
              }
              user.save();
            }
          });
      })
      .catch((err) => {
        that.app.services.ErrorService.handle(err, reply);
      });
  }


  destroy (request, reply) {
    const List = this.app.orm.List;
    const User = this.app.orm.User;

    this.log.debug('[ListController] (destroy) model = list, query =', request.query);
    let that = this;

    List
      .findOne({ _id: request.params.id })
      .then(record => {
        if (!record) {
          throw new Error(Boom.notFound());
        }
        // Set deleted to true
        record.deleted = true;
        return record
          .save()
          .then(() => {
            return record;
          });
      })
      .then((record) => {
        reply(record);
        // Remove all checkins from users in this list
        var criteria = {};
        criteria[record.type + 's.list'] = record._id.toString();
        return User
          .find(criteria)
          .then(users => {
            for (var i = 0; i < users.length; i++) {
              var user = users[i];
              for (var j = 0; j < user[record.type + 's'].length; j++) {
                if (user[record.type + 's'][j].list === record._id) {
                  user[record.type + 's'][j].deleted = true;
                }
              }
              user.save();
            }
          });
      })
      .catch(err => {
        that.app.services.ErrorService.handle(err, reply);
      });
  }

};
