import { getRED, getREDNodes } from './red';
import { getSchemaCache } from './schemaCache';
import { buildIntrospectionQueries, assembleSchemaPayload } from './introspect';
import { formatError } from './errorFormatter';
import type { SchemaPayload } from './types';

function buildSystemPrompt(schema: SchemaPayload, style: string): string {
  const tableList = Object.entries(schema.tables).map(([key, table]) => {
    const cols = table.columns.map(c => {
      let desc = `${c.name}(${c.type}`;
      if (table.primaryKey.includes(c.name)) desc += ' PK';
      const fk = table.foreignKeys.find(f => f.columns.includes(c.name));
      if (fk) desc += ` FK→${fk.foreignTable}.${fk.foreignColumns[fk.columns.indexOf(c.name)]}`;
      if (!c.nullable) desc += ' NOT NULL';
      desc += ')';
      return desc;
    }).join(', ');
    return `- Table "${key}": columns ${cols}`;
  }).join('\n');

  const enumList = Object.entries(schema.enums).map(([key, e]) =>
    `- Enum "${key}": (${e.values.map(v => `'${v}'`).join(', ')})`
  ).join('\n');

  const base = `You are a PostgreSQL query generator. Given a database schema and a natural
language request, produce ONLY a valid PostgreSQL SQL query. No explanations,
no markdown fences — just the query.

Schema:
${tableList}
${enumList}

Rules:
- Use parameterized queries ($1, $2) when the user mentions variable values
- Use table aliases for multi-table queries
- Use COALESCE for nullable columns where sensible
- Never use SELECT * in generated output — list columns explicitly`;

  if (style === 'concise') return base + '\n- Keep queries as short as possible';
  if (style === 'verbose') return base + '\n- Add brief SQL comments explaining joins and filters';
  return base;
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:sql)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

export function init(_RED?: any): void {
  const RED = _RED || getRED();
  if (!RED) return;

  RED.httpAdmin.get('/postgres-introspect/schema/:configId', (req: any, res: any) => {
    const cached = getSchemaCache().get(req.params.configId);
    if (!cached || !cached.payload) {
      return res.json({ stale: true });
    }
    return res.json(cached.payload);
  });

  // POST /postgres-introspect/refresh/:configId
  // Runs actual introspection queries against the database and caches the result.
  // The editor "Refresh Schema" button calls this, not the GET endpoint.
  RED.httpAdmin.post('/postgres-introspect/refresh/:configId', async (req: any, res: any) => {
    const configId = req.params.configId;
    const configNode = RED.nodes.getNode(configId);
    if (!configNode) {
      return res.status(404).json({ error: 'Config node not found' });
    }
    let client: any = null;
    try {
      client = await configNode.pgPool.connect();

      // Get PG version
      const versionResult = await client.query('SHOW server_version');
      const versionParts = versionResult.rows[0].server_version.split('.');
      const version = parseInt(versionParts[0], 10) * 10000 + parseInt(versionParts[1] || '0', 10) * 100;

      // Run introspection queries
      const schema = configNode.schema || 'public';
      const includeSystemCatalogs = configNode.includeSystemCatalogs === true || configNode.includeSystemCatalogs === 'true';
      const queries = buildIntrospectionQueries(schema, false);
      const allRows: any[] = [];
      for (const q of queries) {
        const r = await client.query(q);
        allRows.push(...r.rows);
      }

      const payload = assembleSchemaPayload(allRows, schema, version);

      // Get database name
      try {
        const dbResult = await client.query('SELECT current_database() AS database');
        payload.database = dbResult.rows[0]?.database || 'unknown';
      } catch { /* stays unknown */ }

      getSchemaCache().set(configId, { payload, timestamp: Date.now() });

      const tableCount = Object.keys(payload.tables).length;
      const colCount = Object.values(payload.tables).reduce((sum: number, t: any) => sum + t.columns.length, 0);
      RED.log.info(`Schema refreshed for config ${configId}: ${tableCount} tables, ${colCount} columns`);

      return res.json({ payload, tableCount, colCount });
    } catch (err: any) {
      const structuredError = formatError(err);
      RED.log.warn(`Schema refresh failed for config ${configId}: ${structuredError.message}`);
      return res.status(500).json({ error: structuredError.message, code: structuredError.code });
    } finally {
      if (client) {
        try { client.release(); } catch { /* best-effort */ }
      }
    }
  });

  RED.httpAdmin.post('/postgres-node/generate-query', async (req: any, res: any) => {
    try {
      const { prompt, configId } = req.body;
      const configNode = RED.nodes.getNode(configId);

      if (!configNode) {
        return res.status(404).json({ error: 'Config node not found' });
      }

      const apiKey = configNode.credentials?.openrouterApiKey || configNode.openrouterApiKey;
      if (!apiKey) {
        return res.status(400).json({ error: 'No OpenRouter API key configured. Set it in the PostgresDBNode config.' });
      }

      if (!configNode._schemaCache && !getSchemaCache().get(configId)?.payload) {
        return res.status(400).json({ error: 'Schema not loaded — run introspection first. Add a PostgresIntrospectNode to your flow.' });
      }

      const model = configNode.model || 'openai/gpt-4o-mini';
      const promptStyle = configNode.promptStyle || 'balanced';
      const schema = getSchemaCache().get(configId)?.payload || configNode._schemaCache;
      const systemPrompt = buildSystemPrompt(schema, promptStyle);

      const response = await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/andreabat/node-red-contrib-postgres',
          'X-Title': 'Node-RED Postgres Node',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errBody = await response.text();
        RED.log.warn(`OpenRouter error (${response.status}): ${errBody}`);
        return res.status(502).json({ error: `OpenRouter error: ${response.status}` });
      }

      const data = await response.json();
      const rawQuery = data.choices?.[0]?.message?.content || '';
      const query = stripMarkdownFences(rawQuery);
      return res.json({ query });
    } catch (err: any) {
      RED.log.error(`generate-query error: ${err.message}`);
      return res.status(500).json({ error: err.message || 'Internal error' });
    }
  });
}
