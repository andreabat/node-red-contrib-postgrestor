import { PostgresDBNode } from './src/nodes/PostgresDBNode';
import { PostgresNode } from './src/nodes/PostgresNode';
import { PostgresListenerNode } from './src/nodes/PostgresListenerNode';
import { PostgresIntrospectNode } from './src/nodes/PostgresIntrospectNode';
import { setRED } from './src/lib/red';
import { init as initHttpAdmin } from './src/lib/httpAdmin';

interface Red {
  nodes: {
    createNode: (node: any, config: any) => void;
    registerType: (type: string, constructor: any, opts?: any) => void;
    getNode: (id: string) => any;
  };
  httpAdmin: any;
  log: any;
}

export = function (RED: Red) {
  setRED(RED);
  RED.nodes.registerType('PostgresDBNode', PostgresDBNode, {
    credentials: {
      user: { type: 'text' },
      password: { type: 'password' },
      sslCa: { type: 'password' },
      sslCert: { type: 'password' },
      sslKey: { type: 'password' },
      openrouterApiKey: { type: 'password' }
    }
  });
  RED.nodes.registerType('PostgresNode', PostgresNode);
  RED.nodes.registerType('PostgresListenerNode', PostgresListenerNode);
  RED.nodes.registerType('PostgresIntrospectNode', PostgresIntrospectNode);
  initHttpAdmin();
};
