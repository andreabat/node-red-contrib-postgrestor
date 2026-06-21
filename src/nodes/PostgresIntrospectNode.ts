import { getREDNodes } from '../lib/red';
import { formatError } from '../lib/errorFormatter';
import { buildIntrospectionQueries, assembleSchemaPayload } from '../lib/introspect';
import type { SchemaPayload } from '../lib/types';

// Module-level schema cache, keyed by config node ID
// Used because RED.nodes.getNode() may not return the same object reference
// that was written to by the introspect node's input handler.
const schemaCache = new Map<string, { payload: SchemaPayload; timestamp: number }>();

export function getSchemaCache(): Map<string, { payload: SchemaPayload; timestamp: number }> {
  return schemaCache;
}

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
    const cached = schemaCache.get(config.PostgresDBNode);
    if (!msg.refresh && cached && cached.timestamp > 0) {
      const age = Date.now() - cached.timestamp;
      if (age < cacheTTL) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'Serving from cache' });
        node.send({
          payload: cached.payload,
          schema: cached.payload.schema,
          database: cached.payload.database,
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

      // Run introspection queries (each is a single statement — pg driver rejects multi-statement strings)
      const queries = buildIntrospectionQueries(config.schema, includeSystemCatalogs);
      const allRows: any[] = [];
      for (const q of queries) {
        const r = await client.query(q);
        allRows.push(...r.rows);
      }

      // Assemble payload
      const payload = assembleSchemaPayload(allRows, config.schema, version);

      // Get database name
      try {
        const dbResult = await client.query('SELECT current_database() AS database');
        payload.database = dbResult.rows[0]?.database || 'unknown';
      } catch {
        // Fallback: database stays 'unknown'
      }

      // Cache on config node + module-level map
      configNode._schemaCache = payload;
      configNode._schemaTimestamp = Date.now();
      schemaCache.set(config.PostgresDBNode, { payload, timestamp: Date.now() });

      const tableCount = Object.keys(payload.tables).length;
      const colCount = Object.values(payload.tables).reduce((sum, t) => sum + t.columns.length, 0);
      node.log(`Schema cached for ${config.PostgresDBNode}. Tables: ${tableCount}, cols: ${colCount}`);
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
