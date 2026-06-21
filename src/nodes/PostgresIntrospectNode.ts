import { getREDNodes } from '../lib/red';
import { formatError } from '../lib/errorFormatter';
import { buildIntrospectionQuery, assembleSchemaPayload } from '../lib/introspect';
import type { SchemaPayload } from '../lib/types';

interface PostgresIntrospectNodeConfig {
  name: string;
  PostgresDBNode: string;
  schema: string;
  cacheTTL: string;
  includeSystemCatalogs: string;
}

export function PostgresIntrospectNode(this: any, config: PostgresIntrospectNodeConfig) {
  const RED = getREDNodes();
  const node = this;
  RED.createNode(node, config);
  node.config = RED.getNode(config.PostgresDBNode);

  const cacheTTL = parseInt(String(config.cacheTTL || '300'), 10) * 1000;
  const includeSystemCatalogs = String(config.includeSystemCatalogs) === 'true';

  node.on('input', async (msg: any) => {
    const configNode = node.config;

    // Cache hit — return cached payload without querying
    if (!msg.refresh && configNode._schemaCache && configNode._schemaTimestamp > 0) {
      const age = Date.now() - configNode._schemaTimestamp;
      if (age < cacheTTL) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'Serving from cache' });
        const cached = configNode._schemaCache as SchemaPayload;
        node.send({
          payload: cached,
          schema: cached.schema,
          database: cached.database,
          _msgid: msg._msgid,
        });
        return;
      }
    }

    let client: any = null;
    try {
      client = await configNode.pgPool.connect();
      node.log('Introspecting schema...');

      // Get PG version
      const versionResult = await client.query('SHOW server_version');
      const versionParts = versionResult.rows[0].server_version.split('.');
      const version = parseInt(versionParts[0], 10) * 10000 + parseInt(versionParts[1] || '0', 10) * 100;

      // Run introspection queries
      const query = buildIntrospectionQuery(config.schema, includeSystemCatalogs);
      const result = await client.query(query);

      // Assemble payload
      const payload = assembleSchemaPayload(result.rows, config.schema, version);

      // Get database name
      try {
        const dbResult = await client.query('SELECT current_database() AS database');
        payload.database = dbResult.rows[0]?.database || 'unknown';
      } catch {
        // Fallback: database stays 'unknown'
      }

      // Cache on config node
      configNode._schemaCache = payload;
      configNode._schemaTimestamp = Date.now();

      const tableCount = Object.keys(payload.tables).length;
      const colCount = Object.values(payload.tables).reduce((sum, t) => sum + t.columns.length, 0);
      node.status({ fill: 'green', shape: 'ring', text: `${tableCount} tables, ${colCount} columns` });

      node.send({
        payload,
        schema: payload.schema,
        database: payload.database,
        _msgid: msg._msgid,
      });
    } catch (err: any) {
      const structuredError = formatError(err);
      node.status({ fill: 'red', shape: 'ring', text: `DB unreachable: ${structuredError.message}` });
      node.error(structuredError, msg);
      msg.error = structuredError;
      node.send(msg);
    } finally {
      if (client) {
        try { client.release(); } catch { /* best-effort */ }
      }
    }
  });

  node.on('close', () => {
    node.status({});
  });
}
