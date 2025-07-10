module.exports = function (RED) {
  'use strict';
  const mustache = require('mustache');
  const Pool = require('pg').Pool;

  function getField(node, kind, value) {
    switch (kind) {
      case 'flow': {
        return node.context().flow.get(value);
      }
      case 'global': {
        return node.context().global.get(value);
      }
      case 'num': {
        return parseInt(value);
      }
      case 'bool': {
        return JSON.parse(value);
      }
      default: {
        return value;
      }
    }
  }

  function PostgresDBNode(n) {
    

    const node = this;
    RED.nodes.createNode(node, n);
    node.name = n.name;
    node.host = n.host;
    node.hostFieldType = n.hostFieldType;
    node.port = n.port;
    node.portFieldType = n.portFieldType;
    node.database = n.database;
    node.databaseFieldType = n.databaseFieldType;
    node.ssl = n.ssl;
    node.sslFieldType = n.sslFieldType;
    node.max = n.max;
    node.maxFieldType = n.maxFieldType;
    node.min = n.min;
    node.minFieldType = n.minFieldType;
    node.idle = n.idle;
    node.idleFieldType = n.idleFieldType;
    node.user = n.user;
    node.userFieldType = n.userFieldType;
    node.password = n.password;
    node.passwordFieldType = n.passwordFieldType;

    node.connectionTimeout = n.connectionTimeout;
    node.connectionTimeoutFieldType = n.connectionTimeoutFieldType;
    node.throwErrors = n.throwErrors;
    node.throwErrorsFieldType = n.throwErrorsFieldType;
    console.log("config throwErrors", node.throwErrors);
    
    this.pgPool = new Pool({
      user: getField(node, n.userFieldType, node.credentials.user),
      password: getField(node, n.passwordFieldType, node.credentials.password),
      host: getField(node, n.hostFieldType, n.host),
      port: getField(node, n.portFieldType, n.port),
      database: getField(node, n.databaseFieldType, n.database),
      ssl: getField(node, n.sslFieldType, n.ssl),
      max: getField(node, n.maxFieldType, n.max),
      min: getField(node, n.minFieldType, n.min),
      idleTimeoutMillis: getField(node, n.idleFieldType, n.idle),
      connectionTimeoutMillis: getField(node, n.connectionTimeoutFieldType, n.connectionTimeout),
    });
  }

  RED.nodes.registerType('PostgresDBNode', PostgresDBNode, {
    credentials: {
      user: { type: 'text' },
      password: { type: 'password' },
    }});

  let myPool = false;

  function PostgresNode(config) {
    const node = this;
    RED.nodes.createNode(node, config);
    node.topic = config.topic;
    node.config = RED.nodes.getNode(config.PostgresDBNode);
    node.on('input', (msg) => {
      const query = mustache.render(config.query, { msg });

      const asyncQuery = async () => {
        let client = null;
        try {
          console.log("Connecting to database with query:", query);
          client = await node.config.pgPool.connect();
          console.log("Connected to database");
          msg.payload = await client.query(query, msg.params || []);
           node.status({
            fill: 'green',
            shape: 'ring',
            text: `Query ok. ${msg.payload.rowCount} rows returned`
          });
        } catch (err) {
          const errorMessage = `Error executing query: ${err.message}`;
          node.status({
            fill: 'red',
            shape: 'ring',
            text: errorMessage
          });

          if (config.throwErrors) {
            node.error(errorMessage, msg);
            msg = null;
          } else {
            node.error(errorMessage);
            msg.error = errorMessage;
          }
        } finally {
          if (client) {
            try {
              client.release();
              console.log("Connection released");
            } catch (releaseError) {
              node.error(`Error releasing connection: ${releaseError.message}`);
            }
          }
          node.send(msg);
        }
      };

      asyncQuery().catch((unhandledError) => {
        node.error(`Unhandled error: ${unhandledError.message}`);
      });
    });

    node.on('close', () => {
      node.status({});
    });
  }

  RED.nodes.registerType('PostgresNode', PostgresNode);



  function PostgresListenerNode(config){
    const node = this;
    RED.nodes.createNode(node, config);
    node.config = RED.nodes.getNode(config.PostgresDBNode);
    if(!config.channel){
      //set node status to red with error message
      node.status({
        fill: 'red',
        shape: 'ring',
        text: 'Channel is required'
      });
      return;
    }else{
      node.status({
        fill: 'green',
        shape: 'ring',
        text: `Listening on channel ${config.channel}`
      });
    }
    node.config.pgPool.connect().then(client => {
      client.on('notification', async ({ channel, payload }) => {
        try {
          node.log(`Notification received on channel ${channel}`);
          const msg = { channel, payload };
          node.send(msg);
        } catch (notificationError) {
          node.error(`Error handling notification: ${notificationError.message}`);
        }
      });

      client.query(`LISTEN ${config.channel}`).then(() => {
        node.log(`Listening on channel ${config.channel}`);
      }).catch(err => {
        node.error(`Error setting up LISTEN: ${err.message}`);
      });

    }).catch(connectionError => {
      node.error(`Error connecting to database: ${connectionError.message}`);
    });
  }
  RED.nodes.registerType('PostgresListenerNode', PostgresListenerNode);
};
