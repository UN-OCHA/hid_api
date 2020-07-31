const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const Boom = require('@hapi/boom');
const GSSSync = require('../models/GSSSync');
const List = require('../models/List');
const User = require('../models/User');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
* @module GSSSyncService
* @description GSSSync Service
*/
function getRowFromUser(elt) {
  const organization = elt.organization ? elt.organization.name : '';
  let country = '';
  let region = '';
  let skype = '';
  let bundles = '';
  let roles = '';
  if (elt.location && elt.location.country) {
    country = elt.location.country.name;
  }
  if (elt.location && elt.location.region) {
    region = elt.location.region.name;
  }
  if (elt.voips && elt.voips.length) {
    elt.voips.forEach((voip) => {
      if (voip.type === 'Skype') {
        skype = voip.username;
      }
    });
  }
  if (elt.bundles && elt.bundles.length) {
    elt.bundles.forEach((bundle) => {
      bundles += `${bundle.name};`;
    });
  }
  if (elt.functional_roles && elt.functional_roles.length) {
    elt.functional_roles.forEach((role) => {
      roles += `${role.name};`;
    });
  }
  return [
    elt._id,
    elt.given_name,
    elt.family_name,
    elt.job_title,
    organization,
    bundles,
    roles,
    country,
    region,
    elt.phone_number,
    skype,
    elt.email,
    elt.status,
  ];
}

function getAuthClient(user) {
  // Authenticate with Google
  const creds = JSON.parse(fs.readFileSync('keys/client_secrets.json'));
  const authClient = new OAuth2Client(creds.web.client_id, creds.web.client_secret, 'postmessage');
  authClient.setCredentials(user.googleCredentials);
  return authClient;
}

async function writeUser(gsssync, authClient, user, index) {
  const sheets = google.sheets('v4');
  const values = getRowFromUser(user);
  const body = {
    values: [values],
  };
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: gsssync.spreadsheet,
      range: `A${index}:M${index}`,
      valueInputOption: 'RAW',
      resource: body,
      auth: authClient,
    });
    logger.info(
      `[GSSSyncService->writeUser] Successfully wrote user ${user._id} in ${gsssync.spreadsheet}`,
    );
  } catch (err) {
    logger.error(
      `[GSSSyncService->writeUser] Error writing user to spreadsheet ${gsssync.spreadsheet}`,
      {
        error: err.message,
        err_object: err,
        stack_trace: err.stack,
      },
    );
    if (err.code === 404 || err.code === 403) {
      // Spreadsheet has been deleted, remove the synchronization
      gsssync.remove();
    }
  }
}

/**
 * Add a user to a spreadsheet
 */
async function addUser(agsssync, user) {
  const sheets = google.sheets('v4');
  const gsssync = await agsssync
    .populate('list user')
    .execPopulate();
  const authClient = agsssync.getAuthClient();
  // Find users
  const criteria = gsssync.getUserCriteria();
  if (Object.keys(criteria).length === 0) {
    logger.warn(
      '[GSSSyncService->addUser] User is not authorized to view this list',
    );
    throw Boom.unauthorized('You are not authorized to view this list');
  }
  const users = await User
    .find(criteria)
    .select(GSSSync.getUserAttributes())
    .sort('name')
    .lean();
  try {
    const column = await sheets.spreadsheets.values.get({
      spreadsheetId: gsssync.spreadsheet,
      range: 'A:A',
      auth: authClient,
    });
    if (!column || !column.data || !column.data.values) {
      logger.warn(
        `[GSSSyncService->addUser] column or column.data.values is undefined on spreadsheet ${gsssync.spreadsheet}`,
      );
      throw Boom.badImplementation(`column or column.data.values is undefined on spreadsheet ${gsssync.spreadsheet}`);
    }
    let row = 1; let index = 0;
    users.forEach((tmpUser) => {
      if (row >= column.data.values.length) {
        index = row;
      } else if (column.data.values[row][0] !== tmpUser._id.toString() && index === 0) {
        index = row;
      }
      row += 1;
    });
    if (index !== 0) {
      const body = {
        requests: [{
          insertDimension: {
            range: {
              sheetId: gsssync.sheetId,
              dimension: 'ROWS',
              startIndex: index,
              endIndex: index + 1,
            },
          },
        }],
      };
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: gsssync.spreadsheet,
        resource: body,
        auth: authClient,
      });
      logger.info(
        `[GSSSyncService->addUser] Successfully updated spreadsheet ${gsssync.spreadsheet}`,
      );
      const writeIndex = index + 1;
      await writeUser(gsssync, authClient, user, writeIndex);
    } else {
      logger.warn(
        `[GSSSyncService->addUser] Could not add user ${user._id} to spreadsheet ${gsssync.spreadsheet}`,
      );
      throw Boom.badRequest('Could not add user');
    }
  } catch (err) {
    logger.error(
      `[GSSSyncService->writeUser] Error adding user to spreadsheet ${gsssync.spreadsheet}`,
      {
        fail: true,
        error: err.message,
        err_object: err,
        stack_trace: err.stack,
      },
    );
    if (err.code === 404 || err.code === 403) {
      // Spreadsheet has been deleted, remove the synchronization
      gsssync.remove();
    }
  }
}

async function deleteUser(agsssync, hid) {
  const sheets = google.sheets('v4');
  const gsssync = await agsssync
    .populate('list user')
    .execPopulate();
  const authClient = agsssync.getAuthClient();
  try {
    const column = await sheets.spreadsheets.values.get({
      spreadsheetId: gsssync.spreadsheet,
      range: 'A:A',
      auth: authClient,
    });
    if (!column || !column.data || !column.data.values) {
      logger.warn(
        `[GSSSyncService->deleteUser] column or column.data.values is undefined on spreadsheet ${gsssync.spreadsheet}`,
      );
      throw Boom.badImplementation(`column or column.values is undefined on spreadsheet ${gsssync.spreadsheet}`);
    }
    let row = 0; let
      index = 0;
    column.data.values.forEach((elt) => {
      if (elt[0] === hid) {
        index = row;
      }
      row += 1;
    });
    if (index !== 0) {
      const body = {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: gsssync.sheetId,
              dimension: 'ROWS',
              startIndex: index,
              endIndex: index + 1,
            },
          },
        }],
      };
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: gsssync.spreadsheet,
        resource: body,
        auth: authClient,
      });
      logger.info(
        `[GSSSyncService->deleteUser] Successfully updated spreadsheet ${gsssync.spreadsheet}`,
      );
    } else {
      logger.warn(
        `[GSSSyncService->deleteUser] Could not find user ${hid} in spreadsheet ${gsssync.spreadsheet}`,
      );
      throw Boom.badRequest('Could not find user');
    }
  } catch (err) {
    logger.error(
      `[GSSSyncService->deleteUser] Error removing user from spreadsheet ${gsssync.spreadsheet}`,
      {
        error: err.message,
        err_object: err,
        stack_trace: err.stack,
      },
    );
    if (err.code === 404 || err.code === 403) {
      // Spreadsheet has been deleted, remove the synchronization
      gsssync.remove();
    }
  }
}

async function updateUser(agsssync, user) {
  const sheets = google.sheets('v4');
  const gsssync = await agsssync
    .populate('list user')
    .execPopulate();
  const authClient = agsssync.getAuthClient();
  try {
    const column = await sheets.spreadsheets.values.get({
      spreadsheetId: gsssync.spreadsheet,
      range: 'A:A',
      auth: authClient,
    });
    if (!column || !column.data || !column.data.values) {
      logger.warn(
        `[GSSSyncService->updateUser] column or column.data.values is undefined on spreadsheet ${gsssync.spreadsheet}`,
      );
      throw new Error(`column or column.values is undefined on spreadsheet ${gsssync.spreadsheet}`);
    }
    let row = 0;
    let index = 0;
    column.data.values.forEach((elt) => {
      if (elt[0] === user._id.toString()) {
        index = row + 1;
      }
      row += 1;
    });
    if (index !== 0) {
      await writeUser(gsssync, authClient, user, index);
    } else {
      logger.warn(
        `[GSSSyncService->updateUser] Could not find user ${user._id} in spreadsheet ${gsssync.spreadsheet}`,
        {
          fail: true,
          user: {
            id: user._id,
          },
        },
      );
      throw new Error(`Could not find user ${user._id.toString()} for spreadsheet ${gsssync.spreadsheet}`);
    }
  } catch (err) {
    logger.error(
      `[GSSSyncService->updateUser] Error updating user in spreadsheet ${gsssync.spreadsheet}`,
      {
        fail: true,
        error: err.message,
        err_object: err,
        stack_trace: err.stack,
        user: {
          id: user._id,
        },
      },
    );
    if (err.code === 404 || err.code === 403) {
      // Spreadsheet has been deleted, remove the synchronization
      gsssync.remove();
    }
  }
}

module.exports = {

  async addUserToSpreadsheets(listId, user) {
    const gsssyncs = await GSSSync.find({ list: listId });
    const actions = gsssyncs.map(async (gsssync) => {
      await addUser(gsssync, user);
    });
    return Promise.all(actions);
  },

  async deleteUserFromSpreadsheets(listId, hid) {
    const gsssyncs = await GSSSync.find({ list: listId });
    const actions = gsssyncs.map(async (gsssync) => {
      await deleteUser(gsssync, hid);
    });
    return Promise.all(actions);
  },

  async synchronizeUser(user) {
    // Get all lists from user
    const listIds = user.getListIds();

    // Find the gsssyncs associated to the lists
    const gsssyncs = await GSSSync.find({ list: { $in: listIds } });
    // For each gsssync, call updateUser
    const actions = gsssyncs.map(async (gsssync) => {
      await updateUser(gsssync, user);
    });
    return Promise.all(actions);
  },

  async createSpreadsheet(user, listId) {
    const list = await List.findOne({ _id: listId });
    if (!list) {
      logger.warn(
        `[GSSSyncService->createSpreadsheet] Could not find list ${listId}`,
      );
      throw new Error('List not found');
    }
    const authClient = getAuthClient(user);
    const sheets = google.sheets('v4');
    const request = {
      resource: {
        properties: {
          title: list.name,
        },
        sheets: [{
          properties: {
            gridProperties: {
              rowCount: 10000,
            },
          },
        }],
      },
      auth: authClient,
    };
    const response = await sheets.spreadsheets.create(request);
    logger.info(
      '[GSSSyncService->createSpreadsheet] Successfully created spreadsheet',
    );
    return response;
  },

  async getSheetId(agsssync) {
    const gsssync = await agsssync.populate('user').execPopulate();
    const authClient = agsssync.getAuthClient();
    const sheets = google.sheets('v4');
    const sheet = await sheets.spreadsheets.get({
      spreadsheetId: gsssync.spreadsheet,
      auth: authClient,
    });
    if (sheet) {
      return sheet.sheets[0].properties.sheetId;
    }
    return '';
  },

  async synchronizeAll(agsssync) {
    const headers = GSSSync.getSpreadsheetHeaders();
    const gsssync = await agsssync.populate('list user').execPopulate();
    const authClient = agsssync.getAuthClient();
    const criteria = gsssync.getUserCriteria();
    if (Object.keys(criteria).length === 0) {
      logger.warn(
        '[GSSSyncService->synchronizeAll] User is not authorized to view this list',
      );
      throw Boom.unauthorized('You are not authorized to view this list');
    }
    const users = await User
      .find(criteria)
      .select(GSSSync.getUserAttributes())
      .sort('name')
      .lean();
    // Export users to spreadsheet
    const data = [];
    let index = 2;
    let row = [];
    data.push({
      range: 'A1:M1',
      values: [headers],
    });
    users.forEach((elt) => {
      row = getRowFromUser(elt);
      data.push({
        range: `A${index}:M${index}`,
        values: [row],
      });
      index += 1;
    });
    const body = {
      data,
      valueInputOption: 'RAW',
    };
    const sheets = google.sheets('v4');
    return sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: gsssync.spreadsheet,
      resource: body,
      auth: authClient,
    });
  },

};
