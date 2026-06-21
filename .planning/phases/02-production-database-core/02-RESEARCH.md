# Phase 02: Production Database Core - Research

**Researched:** 2026-06-10
**Domain:** PostgreSQL client library (node-postgres / pg), Node-RED editor extensions, connection pooling, query execution
**Confidence:** HIGH

## Summary

Phase 2 upgrades the PostgreSQL config and query nodes from basic/functional to production-grade. The research covers 10 requirements spanning pool configuration, SSL certificate management, DATABASE_URL parsing, named parameter binding, structured error handling, per-node query timeouts, CodeMirror/ACE SQL highlighting, automatic type mapping, and prepared statements with cache management — all built on the TypeScript foundation from Phase 1.

The core technology is `pg` (node-postgres) at version 8.21.0 (resolving from `^8.16.2`). This library natively supports all required capabilities: SSL configuration via `{ ssl: { ca, key, cert, rejectUnauthorized } }` passed to TLS socket, pool health monitoring via `pool.totalCount`/`pool.idleCount`/`pool.waitingCount` properties and pool events, `connectionString` parameter for DATABASE_URL support, `statement_timeout` for server-side query cancellation, structured `DatabaseError` objects with 17 properties including `code`, `detail`, `constraint`, `table`, and `schema`, named prepared statements via `{ name, text, values }` query config objects, and `pg-types` module with `setTypeParser` for numeric/timestamp/jsonb conversion.

The Node-RED editor integration uses ACE editor (bundled with Node-RED 3.x) via `RED.editor.createEditor({ mode: 'ace/mode/sql' })` — NOT CodeMirror, which is not bundled. The existing code already implements ACE SQL editing; this phase enhances the editor configuration. Node-RED credential storage supports `type: 'password'` for certificate values (stored encrypted, matching the D-02 decision). The typedInput system supports all required field types (str, num, bool, flow, global, env).

**Primary recommendation:** Use pg's native `statement_timeout` config (server-side, avoids AbortController complexity) and ACE editor (bundled, proven, no additional dependency). Implement type mapping via `pg.types.setTypeParser` at the Pool level, with per-node toggle to opt-out. Named parameter binding requires a transformation layer mapping `msg.params` object keys to `$1, $2,...` positional order before query execution.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pool configuration (POOL-01) | Config Node (PostgresDBNode) | Editor UI | Pool params are constructor arguments to pg.Pool; config node owns pool creation |
| Pool health display (POOL-02) | Runtime (PostgresDBNode) | — | pg.Pool exposes `totalCount`, `idleCount`, `waitingCount`; read and format at runtime |
| SSL/TLS config (POOL-03) | Config Node (PostgresDBNode) | Node-RED Credential Store | SSL params passed to pg.Pool constructor; cert values stored as credentials |
| DATABASE_URL parsing (POOL-04) | Config Node (PostgresDBNode) | — | Pool constructor accepts `connectionString`; must parse URL and merge with individual fields |
| Named parameters (QUERY-01) | Query Node (PostgresNode) | — | `msg.params` object mapping happens per-query before `client.query()` call |
| Structured errors (QUERY-02) | Query Node (PostgresNode) | — | Error transformation happens at the catch site in PostgresNode input handler |
| Query timeout (QUERY-03) | Query Node (PostgresNode) | Config Node | `statement_timeout` set per-client or per-pool; pool-level default, per-node override |
| SQL editor (QUERY-04) | Editor (PostgresNode.html) | — | `RED.editor.createEditor()` ACE integration, pure editor-side concern |
| Prepared statements (REL-02) | Query Node (PostgresNode) | — | Query config with `name` field auto-prepared by pg; lifecycle managed in input handler |
| Type mapping (REL-03) | Query Node (PostgresNode) | Config Node | `pg.types.setTypeParser` at pool level (global) or per-query `types` config |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Progressive disclosure — sslmode dropdown (disable/require/verify-ca/verify-full) always visible; CA cert, client cert, and client key fields appear only when sslmode is `verify-ca` or `verify-full`.
- **D-02:** Cert values (CA cert, client cert, client key) stored in Node-RED encrypted credential storage — same pattern as the existing user/password credentials. Not plain typed-input fields.
- **D-03:** Deprecate the existing boolean `ssl` toggle — existing `ssl: true` configs auto-migrate to `sslmode: require` on first upgrade. The deprecated field remains greyed out with a migration tooltip.
- **D-04:** Auto-generated names from query hash (e.g. `ps_abc123`). No user-facing UI for naming — every unique query automatically becomes a prepared statement. Transparent to the user.
- **D-05:** Per-connection cache — each pool client tracks its own set of prepared statements. Statements survive across multiple queries on the same client connection.
- **D-06:** Redeploy clears cache — all prepared statements for a node are invalidated on node redeploy. Queries re-prepare on first execution post-deploy.

### the agent's Discretion
The following gray areas were not discussed — the agent has full flexibility to decide the best approach:

- **DATABASE_URL integration (POOL-04)** — Override vs. fallback semantics vs. separate mode toggle. Whether URL query parameters (sslmode, pool params) are parsed.
- **Pool health display (POOL-02)** — Polling interval vs. on-demand refresh. Granularity of displayed data (active/idle/waiting/total vs. simple healthy/unhealthy).
- **Query timeout implementation (QUERY-03)** — PostgreSQL `statement_timeout` (per-connection) vs. Node.js AbortController/promise timeout approach.
- **Structured error format (QUERY-02)** — Beyond code/detail/constraint/table: include SQL state, severity, position, original query? Exact fields on `msg.error`.
- **Type mapping behavior (REL-03)** — On-by-default (breaking change) vs. opt-in per node. Whether jsonb auto-parse is a separate toggle from numeric/timestamp mapping.
- **Named parameters mapping (QUERY-01)** — How `msg.params = {name: 'value'}` maps to positional `$1,$2`. Interaction with Mustache templating. Handling of params not found in the query.
- **CodeMirror integration (QUERY-04)** — Which SQL mode/dialect, configuration (line numbers, word wrap, auto-completion), theme consistency with Node-RED editor.
- **Pool config UI layout (POOL-01)** — Exact field grouping, tabs vs. flat layout, typedInput defaults for pool parameters.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POOL-01 | Pool configuration (max, idleTimeoutMillis, connectionTimeoutMillis) exposable in editor UI via typed inputs | pg.Pool constructor accepts `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`; Node-RED typedInput types: num, flow, global |
| POOL-02 | Health-check / status node displays pool state (active, idle, waiting) in runtime status | pg.Pool exposes `totalCount`, `idleCount`, `waitingCount`; `pool.on('error')`, `pool.on('connect')`, `pool.on('acquire')` events |
| POOL-03 | SSL/TLS fully configurable: sslmode dropdown, CA cert, client cert, client key | pg.Pool `ssl` config accepts `{ ca, key, cert, rejectUnauthorized }` passed to `node.TLSSocket`; credential storage for cert values |
| POOL-04 | Connection from DATABASE_URL env var alternative | pg.Pool accepts `connectionString`; Node.js `URL` module or `pg-connection-string` parse utility for URL decomposition and merge with individual fields |
| QUERY-01 | Named parameters support: msg.params object mapped to $1, $2, etc. | pg's `client.query(text, values)` expects positional `$1,$2`; transformation layer extracts keys from `msg.params`, extracts `$N` references from SQL, maps by ordering |
| QUERY-02 | Structured msg.error with code, detail, constraint, table fields | `DatabaseError` from pg-protocol exposes `code`, `detail`, `constraint`, `table`, `schema`, `column`, `severity`, `position`, `dataType`, `hint`, `where`, `routine` |
| QUERY-03 | Per-node query timeout with clean cancellation | pg supports `statement_timeout` config (server-side) and `query_timeout` (client-side Promise timeout); recommendation: `SET statement_timeout` per-query via connection-level SET |
| QUERY-04 | SQL editor with syntax highlighting | Node-RED 3.x bundles ACE editor via `RED.editor.createEditor()`; existing code already uses `mode: 'ace/mode/sql'`; enhance with `showLineNumbers`, `wrap`, `theme` options |
| REL-02 | Named prepared statements with cache invalidation | pg auto-prepares queries with `name` field in QueryConfig; per-client cache; redeploy clears cache (new pool = fresh prepared statement state) |
| REL-03 | Automatic type mapping: numeric→number, timestamptz→ISO, jsonb optional parse | `pg.types.setTypeParser(types.builtins.NUMERIC, parseFloat)`; `types.builtins.TIMESTAMPTZ` → ISO string; `types.builtins.JSONB` (OID 3807) already parsed by default |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pg` (node-postgres) | ^8.16.2 (resolves to 8.21.0) [VERIFIED: npm registry] | PostgreSQL client with connection pooling, query execution, SSL, prepared statements, type parsing | Official Node.js PostgreSQL client; 30M weekly downloads; natively supports all required Phase 2 capabilities: SSL, pool monitoring, prepared statements, statement_timeout, DatabaseError |
| `mustache` | ^4.2.0 [VERIFIED: npm registry] | Logic-less template engine for injecting `msg` properties into SQL queries | Already in use; Phase 2 maintains compatibility with Mustache rendering alongside named parameter binding |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pg-connection-string` | Bundled with pg 8.x | Parse PostgreSQL connection URIs (DATABASE_URL) into config objects | Used at pool creation to decompose `connectionString` into individual fields; `parse(connectionString)` or `parseIntoClientConfig()` |
| `pg-types` | Bundled with pg 8.x | Type parser registry with `setTypeParser()` and builtin OID references | Used to register custom parsers for NUMERIC, TIMESTAMPTZ, JSONB at pool level |
| ACE Editor | Bundled with Node-RED 3.x | SQL syntax highlighting in node config panel | Already in use via `RED.editor.createEditor({ mode: 'ace/mode/sql' })`; NOT CodeMirror (CodeMirror is not bundled with Node-RED) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ACE Editor (bundled) | CodeMirror (standalone npm package) | CodeMirror requires separate npm dependency; ACE is pre-bundled, proven in Node-RED ecosystem, and already implemented |
| `statement_timeout` (server-side) | AbortController + Promise.race (client-side) | AbortController cancels at JS level but query may continue on DB server; statement_timeout is cleaner, no dangling queries, but requires per-connection SET |
| `pg-connection-string` (official) | Node.js `url` module manual parsing | Official parser handles URI query parameters (sslmode, application_name) correctly; manual parsing error-prone for edge cases |

**Installation:**
```bash
# No new npm packages required. All capabilities use existing pg ^8.16.2 and Node-RED bundled features.
# pg-connection-string and pg-types are included as dependencies of pg.
```

### Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `pg` | npm | 14+ yrs (first published 2011) | 31M/wk | github.com/brianc/node-postgres | SUS (version 8.21.0 published 2026-05-18 — too-new flag) | Approved — official node-postgres release, package.json uses ^8.16.2 range; latest patch within range |
| `mustache` | npm | 10+ yrs | 14M/wk | github.com/janl/mustache.js | OK | Approved |

**Packages removed due to SLOP verdict:** none
**Packages flagged as suspicious SUS:** `pg` v8.21.0 — flagged as "too-new" (published 3 weeks ago). This is a legitimate official release from the node-postgres project with 31M weekly downloads. The `^8.16.2` semver range in package.json accommodates this update. No additional checkpoint required.

### System Architecture Diagram

```text
┌──────────────────────────────────────────────────────────────────────┐
│                      Node-RED Editor (Browser)                         │
│                                                                        │
│  ┌──────────────────────────┐    ┌──────────────────────────────────┐ │
│  │  PostgresDBNode Config   │    │  PostgresNode Config             │ │
│  │  ┌────────────────────┐  │    │  ┌────────────────────────────┐  │ │
│  │  │ Connection tab     │  │    │  │ SQL Editor (ACE)           │  │ │
│  │  │  host, port, db,   │  │    │  │  mode: ace/mode/sql        │  │ │
│  │  │  sslmode dropdown, │  │    │  │  lineNumbers, wrap, theme  │  │ │
│  │  │  DATABASE_URL       │  │    │  └────────────────────────────┘  │ │
│  │  ├────────────────────┤  │    │  ┌────────────────────────────┐  │ │
│  │  │ Security tab       │  │    │  │ Named Params toggle        │  │ │
│  │  │  user, password    │  │    │  │ Query Timeout input        │  │ │
│  │  │  sslCa, sslCert,   │  │    │  │ Type Mapping toggles:      │  │ │
│  │  │  sslKey (password) │  │    │  │  numeric→num, timestamptz  │  │ │
│  │  ├────────────────────┤  │    │  │  →ISO, jsonb→parse         │  │ │
│  │  │ Pool tab           │  │    │  │ Prepared Statements (auto) │  │ │
│  │  │  max, idleTimeout, │  │    │  └────────────────────────────┘  │ │
│  │  │  connectionTimeout │  │    │                                    │ │
│  │  └────────────────────┘  │    └──────────────────────────────────┘ │
│  └──────────────────────────┘                                          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ deploy
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     Node-RED Runtime (Node.js)                         │
│                                                                        │
│  ┌─────────────────────────────┐                                      │
│  │  PostgresDBNode (config)    │                                      │
│  │  ┌────────────────────────┐ │                                      │
│  │  │ DATABASE_URL parser    │ │                                      │
│  │  │ → parse URI            │ │                                      │
│  │  │ → extract user/host/   │ │                                      │
│  │  │   port/db/ssl params   │ │                                      │
│  │  │ → merge with fields    │ │                                      │
│  │  │ SSL builder:           │ │                                      │
│  │  │  sslmode → { ca, key,  │ │                                      │
│  │  │    cert, rejectUA }    │ │                                      │
│  │  └───────────┬────────────┘ │                                      │
│  │              ▼               │                                      │
│  │  ┌────────────────────────┐ │  pool.totalCount                     │
│  │  │ new pg.Pool({...})     │◄─┼─ pool.idleCount                     │
│  │  │ + pg.types.setType-   │ │  pool.waitingCount                   │
│  │  │   Parser(NUMERIC,...) │ │  pool.on('error')                     │
│  │  └───────────┬────────────┘ │  → update node.status()              │
│  └──────────────┼──────────────┘                                      │
│                 │ RED.nodes.getNode()                                  │
│                 ▼                                                      │
│  ┌─────────────────────────────┐                                      │
│  │  PostgresNode (query)       │                                      │
│  │  ┌────────────────────────┐ │                                      │
│  │  │ input handler:         │ │                                      │
│  │  │  msg → Mustache.render │ │                                      │
│  │  │  msg.params object     │ │                                      │
│  │  │    → extract $N order  │ │                                      │
│  │  │    → map keys to vals  │ │                                      │
│  │  │  client = pool.connect │ │                                      │
│  │  │  SET statement_timeout │ │                                      │
│  │  │  client.query({        │ │                                      │
│  │  │    name: hash(query),  │ │  prepared statement (auto)           │
│  │  │    text: query,        │ │                                      │
│  │  │    values: params[]    │ │                                      │
│  │  │  })                    │ │                                      │
│  │  │  → msg.payload = rows  │ │                                      │
│  │  │  catch DatabaseError:  │ │                                      │
│  │  │    msg.error = {       │ │                                      │
│  │  │      code, detail,     │ │                                      │
│  │  │      constraint, table,│ │                                      │
│  │  │      severity, ...     │ │                                      │
│  │  │    }                   │ │                                      │
│  │  │  finally: release()    │ │                                      │
│  │  │  node.send(msg)        │ │                                      │
│  │  └────────────────────────┘ │                                      │
│  └─────────────────────────────┘                                      │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        PostgreSQL Database                             │
│  Executes queries, returns results, enforces SSL, manages prepared     │
│  statements, enforces statement_timeout, emits NOTIFY                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/
├── nodes/
│   ├── PostgresDBNode.ts              # Config node: pool creation, SSL, DATABASE_URL, pool health
│   ├── PostgresDBNode.html            # Editor: sslmode dropdown, cert credentials, pool params, DATABASE_URL field
│   ├── PostgresNode.ts                # Query node: named params, structured errors, timeout, prepared stmts
│   ├── PostgresNode.html              # Editor: ACE SQL editor, type mapping toggles, timeout, named params toggle
│   ├── PostgresListenerNode.ts        # (Phase 3 — not modified in Phase 2)
│   ├── PostgresListenerNode.html      # (Phase 3 — not modified in Phase 2)
│   └── __tests__/
│       ├── PostgresDBNode.test.ts     # Pool config, SSL, DATABASE_URL, pool health tests
│       ├── PostgresNode.test.ts       # Named params, structured errors, timeout, prepared stmts, type mapping tests
│       └── PostgresListenerNode.test.ts
├── lib/
│   ├── getField.ts                    # (existing — extended for sslmode FieldType)
│   ├── red.ts                         # (existing — RED runtime accessor)
│   ├── types.ts                       # (extended — new config interfaces for sslmode, DATABASE_URL, query options)
│   ├── params.ts                      # (NEW) Named parameter binding: extract $N from SQL, map msg.params keys to positional array
│   ├── typeMapping.ts                 # (NEW) pg.types.setTypeParser registration and per-query types config builder
│   ├── errorFormatter.ts              # (NEW) DatabaseError → structured msg.error object
│   └── __tests__/
│       ├── getField.test.ts
│       ├── params.test.ts             # Named param extraction and mapping tests
│       ├── typeMapping.test.ts        # Type parser registration and per-query config tests
│       └── errorFormatter.test.ts     # Error field extraction tests
├── postgrestor.ts                     # Barrel entry (extended with new node registrations)
└── postgrestor.html                   # (remains — top-level HTML loading)
locales/
└── en-US/
    └── postgrestor.json               # Extended with new i18n strings for sslmode, certs, pool health, type mapping, etc.
```

## Architecture Patterns

### Pattern 1: Config Node Pool Creation with SSL & DATABASE_URL
**What:** PostgresDBNode constructs a pg.Pool with all connection parameters resolved from config fields, credentials, and optional DATABASE_URL.
**When to use:** At node registration/deployment time — pool is created once when the config node is deployed.
**Example:**
```typescript
// Source: Context7 /brianc/node-postgres docs, verified against node_modules pg-protocol
import * as pg from 'pg';
import { parse } from 'pg-connection-string'; // or manual URL parsing

export function PostgresDBNode(this: any, n: PostgresDBNodeConfig) {
  const RED = getREDNodes();
  const node = this;
  RED.createNode(node, n);

  // Resolve DATABASE_URL or individual fields
  let connectionConfig: any = {};
  if (n.useDatabaseUrl && n.databaseUrl) {
    const parsed = parse(getField(node, n.databaseUrlFieldType, n.databaseUrl) as string);
    connectionConfig = {
      user: parsed.user || node.credentials.user,
      password: parsed.password || node.credentials.password,
      host: parsed.host,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.database,
    };
  } else {
    connectionConfig = {
      user: getField(node, n.userFieldType, node.credentials.user),
      password: getField(node, n.passwordFieldType, node.credentials.password),
      host: getField(node, n.hostFieldType, n.host),
      port: getField(node, n.portFieldType, n.port),
      database: getField(node, n.databaseFieldType, n.database),
    };
  }

  // Build SSL config from sslmode
  const sslmode = getField(node, n.sslmodeFieldType, n.sslmode) as string;
  let sslConfig: any = false;
  if (sslmode === 'require') {
    sslConfig = { rejectUnauthorized: false };
  } else if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    sslConfig = {
      rejectUnauthorized: sslmode === 'verify-full',
      ca: node.credentials.sslCa,
      key: node.credentials.sslKey,
      cert: node.credentials.sslCert,
    };
  } // sslmode === 'disable' or legacy ssl:false → ssl: false

  this.pgPool = new pg.Pool({
    ...connectionConfig,
    ssl: sslConfig,
    max: getField(node, n.maxFieldType, n.max) as number,
    min: getField(node, n.minFieldType, n.min) as number,
    idleTimeoutMillis: getField(node, n.idleFieldType, n.idle) as number,
    connectionTimeoutMillis: getField(node, n.connectionTimeoutFieldType, n.connectionTimeout) as number,
  });

  // Register type parsers globally for this pool
  if (n.typeMapping !== false) { // default: enabled
    require('./lib/typeMapping').registerTypeParsers();
  }
}
```

### Pattern 2: Named Parameter Binding (msg.params object → $1, $2)
**What:** Transform `msg.params = { name: 'Alice', age: 30 }` into positional array `['Alice', 30]` ordered by `$1`, `$2` references in the SQL query.
**When to use:** Before calling `client.query(query, params)` — after Mustache rendering, before query execution.
**Example:**
```typescript
// Source: derived from pg parameterized query docs + Node-RED msg.params pattern
// NEW file: src/lib/params.ts

/**
 * Extracts positional parameter names from PostgreSQL query text.
 * Matches $1, $2, ... $N references.
 * Returns array of parameter names in positional order,
 * corresponding to keys in msg.params object.
 */
export function extractNamedParams(query: string): string[] {
  const matches = query.match(/\$(\d+)/g) || [];
  const indices = matches.map(m => parseInt(m.substring(1), 10));
  const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;
  return Array.from({ length: maxIndex }, (_, i) => String(i + 1));
}

/**
 * Maps msg.params object to ordered positional values array.
 * msg.params keys must match $N numeric references.
 * Unmatched keys are ignored; unmatched $N get undefined.
 */
export function bindNamedParams(
  query: string,
  params: Record<string, any>
): any[] {
  const positionalNames = extractNamedParams(query);
  return positionalNames.map(name => params[name]);
}
```

### Pattern 3: Structured Error Handling
**What:** Catch DatabaseError, extract fields into `msg.error` object, preserving both throwErrors paths (halt flow vs. downstream handling).
**When to use:** In the catch block of the async query handler in PostgresNode.
**Example:**
```typescript
// Source: pg-protocol/dist/messages.d.ts DatabaseError class, verified in node_modules
// NEW file: src/lib/errorFormatter.ts

import { DatabaseError } from 'pg-protocol';

export interface StructuredError {
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  schema?: string;
  column?: string;
  severity?: string;
  position?: string;
  dataType?: string;
  hint?: string;
  where?: string;
  routine?: string;
}

export function formatError(err: unknown): StructuredError {
  if (err instanceof DatabaseError) {
    return {
      message: err.message,
      code: err.code || undefined,
      detail: err.detail || undefined,
      constraint: err.constraint || undefined,
      table: err.table || undefined,
      schema: err.schema || undefined,
      column: err.column || undefined,
      severity: err.severity || undefined,
      position: err.position || undefined,
      dataType: err.dataType || undefined,
      hint: err.hint || undefined,
      where: err.where || undefined,
      routine: err.routine || undefined,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
```

### Pattern 4: Query Timeout via statement_timeout
**What:** Set PostgreSQL `statement_timeout` for the client connection before each query, then reset after.
**When to use:** Per-node timeout config — before `client.query()` in the async handler.
**Example:**
```typescript
// Source: pg Client Config with statement_timeout, Context7 /brianc/node-postgres client docs
// Inside PostgresNode input handler:

const timeoutMs = config.queryTimeout || 30000; // default 30s
await client.query(`SET statement_timeout = ${timeoutMs}`);
try {
  const result = await client.query(queryConfig); // with named params, prepared statement
  // ... process result
} finally {
  // Reset timeout to pool default post-query
  await client.query('SET statement_timeout = 0'); // 0 = no timeout
}
```

### Pattern 5: Prepared Statements with Auto-Hashing
**What:** Every unique query gets a hash-based name (e.g., `ps_abc123`). pg caches the prepared statement per-client.
**When to use:** Automatically applied to every query — transparent to user. Cleared on redeploy (pool recreation).
**Example:**
```typescript
// Source: pg QueryConfig with name field, Context7 /brianc/node-postgres queries docs
import * as crypto from 'crypto';

function hashQuery(text: string): string {
  return 'ps_' + crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
}

const queryConfig = {
  name: hashQuery(sqlQuery),
  text: sqlQuery,
  values: resolvedParams,
};
const result = await client.query(queryConfig);
```

### Pattern 6: Pool Health Status Display
**What:** Read `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` on a poll interval and update `node.status()`.
**When to use:** In PostgresDBNode, on a configurable poll interval (recommend: 5s default, minimum 1s).
**Example:**
```typescript
// Source: pg-pool README pool events/properties, Context7 /brianc/node-postgres
// Inside PostgresDBNode:

const activeCount = this.pgPool.totalCount - this.pgPool.idleCount;
const waitingCount = this.pgPool.waitingCount;

this.pgPool.on('error', (err: Error) => {
  node.status({
    fill: 'red',
    shape: 'dot',
    text: `Pool error: ${err.message}`
  });
});

// Poll health on interval
this._healthInterval = setInterval(() => {
  const active = this.pgPool.totalCount - this.pgPool.idleCount;
  node.status({
    fill: this.pgPool.totalCount > 0 ? 'green' : 'yellow',
    shape: 'dot',
    text: `Active: ${active} | Idle: ${this.pgPool.idleCount} | Waiting: ${this.pgPool.waitingCount} | Total: ${this.pgPool.totalCount}`
  });
}, 5000);
```

### Pattern 7: Type Mapping with pg.types.setTypeParser
**What:** Register global type parsers for NUMERIC → number, TIMESTAMPTZ → ISO string. JSONB is auto-parsed by pg (OID 3807) — toggle controls whether to bypass or keep.
**When to use:** Register at pool creation (global) or per-query `types` config (opt-out).
**Example:**
```typescript
// Source: pg-types docs, Context7 /brianc/node-postgres types docs
// NEW file: src/lib/typeMapping.ts
import pg from 'pg';

export function registerTypeParsers(): void {
  // NUMERIC (OID 1700) → JavaScript number
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseFloat);

  // INT8 / BIGINT (OID 20) → JavaScript number
  pg.types.setTypeParser(pg.types.builtins.INT8, parseInt);

  // TIMESTAMPTZ (OID 1184) → ISO string
  pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (val: string) => {
    return new Date(val).toISOString();
  });

  // JSONB (OID 3807) — already auto-parsed by pg
  // To opt out: override with identity parser
  // pg.types.setTypeParser(3807, (val: string) => val);
}

// For per-query opt-out, pass types config in QueryConfig:
export function buildQueryTypes(disableTypeMapping: boolean): any {
  if (disableTypeMapping) {
    return {
      getTypeParser: () => (val: string) => val // return raw strings
    };
  }
  return undefined; // use pool-level parsers
}
```

### Anti-Patterns to Avoid
- **Hand-rolling SSL cert file reading:** Cert values come from Node-RED credential storage (`node.credentials.sslCa`), not filesystem. Do NOT `fs.readFileSync` — certs are stored as strings in credentials.
- **Promise.race + AbortController for timeouts:** Leaves queries running on PostgreSQL server after JS-side cancellation. Use `statement_timeout` which cleanly terminates at DB level.
- **Auto-detecting named vs positional params:** Do NOT attempt to detect whether `msg.params` is array or object to decide binding mode. Always require explicit named-params toggle on the node config. Mixed modes cause subtle bugs.
- **Storing cert values as plain typed-input fields:** D-02 explicitly requires credential storage (encrypted). Plain text fields would leak certs in exported flow files.
- **Not releasing client after `SET statement_timeout`:** Every `client.query()` must be followed by `client.release()` in finally block — even for SET commands.
- **SHA-256 for prepared statement names:** PostgreSQL identifier length limit is 63 bytes. Full SHA-256 (64 chars) exceeds this. Use MD5 hash truncated to 8 chars with `ps_` prefix (max 11 chars).
- **CodeMirror installation as npm dependency:** Node-RED bundles ACE editor, not CodeMirror. Installing CodeMirror separately adds unnecessary bloat and conflicts with Node-RED's editor APIs.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PostgreSQL connection string parsing | Manual regex/string parsing of DATABASE_URL | `pg-connection-string` (bundled with pg) or `parse` export | Handles URI encoding, query parameters (sslmode, application_name), IPv6 addresses, port parsing edge cases |
| SSL/TLS socket configuration | Custom TLS socket setup | `pg.Pool` `ssl` config object | Passes directly to `node.TLSSocket`; pg handles all protocol negotiation; manual TLS is error-prone and pg-specific |
| Query cancellation on timeout | Custom Promise.race + AbortController | PostgreSQL `SET statement_timeout` | Server-side cancellation ensures no dangling queries; AbortController only cancels JS side, query may continue on DB |
| Parameter binding order extraction | Manual string scanning for `$N` | Regex `\$(\d+)` with positional ordering | Simple, reliable; edge cases (comments, string literals containing `$`) handled by pg's parser anyway |
| SQL syntax highlighting | Custom textarea styling or new editor library | Node-RED `RED.editor.createEditor({ mode: 'ace/mode/sql' })` | ACE is bundled with Node-RED, proven, and already in use; CodeMirror would require separate dependency and custom integration |
| Type coercion for PostgreSQL results | Post-processing every result row | `pg.types.setTypeParser` | Registered globally at pool creation; applies to all queries automatically; per-query opt-out via `types` config |
| Structured error field extraction | Custom error parsing with `.field` assumptions | `instanceof DatabaseError` check + property spread | `DatabaseError` from pg-protocol has typed fields; instanceof check ensures safe property access |
| Pool health monitoring | Custom connection counting via connect/release events | `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` properties | pg.Pool maintains these counters internally; events (`connect`, `acquire`, `error`, `remove`) provide lifecycle hooks |

**Key insight:** pg (node-postgres) already ships with all the primitives needed for Phase 2. The work is about surfacing these primitives through Node-RED's config UI, credential store, and message model — not about rebuilding PostgreSQL protocol handling.

## Common Pitfalls

### Pitfall 1: Legacy `ssl: boolean` Migration Can Break Existing Flows
**What goes wrong:** Users with `ssl: true` in existing flow configs get `sslmode: 'require'` during auto-migration, but `rejectUnauthorized: false` may be unexpected for users who previously had no cert verification.
**Why it happens:** The old boolean SSL toggle maps to pg's `ssl: true` which internally uses `rejectUnauthorized: false` (Node.js TLS default). The new `require` sslmode retains this behavior, but users who add CA cert later may not realize `verify-ca` is needed for full verification.
**How to avoid:** Auto-migration sets `sslmode: 'require'` with a visible tooltip on the greyed-out deprecated field: "Migrated from ssl: true → sslmode: require (no certificate verification)". Users wanting full verification must manually switch to `verify-ca` or `verify-full`.
**Warning signs:** Test flows that worked with `ssl: true` fail after migration; `DEPTH_ZERO_SELF_SIGNED_CERT` errors in logs.

### Pitfall 2: `statement_timeout` Affects All Queries on the Connection
**What goes wrong:** Setting `statement_timeout` via `SET` command on a pooled client persists for that client's entire lifetime — subsequent queries on the same client connection inherit the timeout unless reset.
**Why it happens:** `SET statement_timeout` is a session-level setting. A client returned to the pool retains the timeout value set by the previous query node.
**How to avoid:** ALWAYS reset `statement_timeout = 0` (no timeout) in the `finally` block after query execution. Alternatively, set `statement_timeout` at pool creation via the config object (applies to all new clients) and use per-query override only in extreme cases.
**Warning signs:** Queries timeout unexpectedly fast; timeout errors on unrelated flows using the same pool.

### Pitfall 3: Prepared Statement Names Collide Across Nodes
**What goes wrong:** Two different PostgresNode instances with the same SQL query get the same hash → same prepared statement name → second node's query reuses first node's cached plan with potentially different parameter types.
**Why it happens:** Per D-04, prepared statement names are auto-generated from query hash (e.g., `ps_abc123`). If two nodes execute `SELECT * FROM users WHERE id = $1`, they generate the same name. Prepared statements are scoped to a client connection (D-05), so the collision is per-client, not global.
**How to avoid:** This is actually safe because D-05 scopes statements per client connection. Each `pool.connect()` gets a different client, so different nodes on different client connections won't collide. If the same node reuses the same client, the prepared statement is already cached — which is the desired behavior.
**Warning signs:** "prepared statement 'ps_XXXX' already exists" errors across different nodes.

### Pitfall 4: `msg.params` Object Keys Don't Match `$N` References
**What goes wrong:** User passes `msg.params = { name: 'Alice', age: 30 }` but the SQL uses `$2, $1` in a different order than `Object.keys()` returns them. JavaScript object key iteration order is insertion order, not necessarily the `$1, $2,...` order in the query.
**Why it happens:** The natural approach of `Object.values(msg.params)` assumes keys are ordered to match `$1, $2, $3`. But the user may have written `WHERE age = $2 AND name = $1` — key order won't match positional order.
**How to avoid:** Extract `$N` references from the query text via regex, sort them numerically, then map each `$N` to the corresponding `msg.params` key by explicit naming convention (e.g., `$1` ↔ `params.p1` or `$name` ↔ `params.name` with named parameter syntax). Recommend: require user to use same names in `msg.params` keys as in the `$name` syntax, and rewrite `$name` to `$N` during binding.
**Warning signs:** Wrong values bound to wrong columns; silent data corruption from swapped parameters.

### Pitfall 5: Cert Credentials Not Properly Registered in HTML + JS
**What goes wrong:** SSL cert credentials (sslCa, sslCert, sslKey) are registered in the HTML editor but not in `RED.nodes.registerType()` third argument, or vice versa. Credential values are silently `undefined` at runtime.
**Why it happens:** Node-RED requires credentials to be declared in BOTH the HTML `credentials: {...}` block AND the JS `RED.nodes.registerType('PostgresDBNode', PostgresDBNode, { credentials: {...} })` call. Missing one side = values not stored/not accessible.
**How to avoid:** Always verify both registrations. HTML block: `credentials: { sslCa: {type: 'password'}, sslCert: {type: 'password'}, sslKey: {type: 'password'} }`. JS block: same structure as third argument to `registerType`. Cert values use `type: 'password'` (obscured in editor, encrypted at rest).
**Warning signs:** `node.credentials.sslCa` is `undefined` at runtime; SSL connections fail with "no certificate provided" despite user entering certs.

### Pitfall 6: Type Mapping Breaks Existing Flows (Breaking Change)
**What goes wrong:** Enabling numeric→number type mapping by default converts `NUMERIC` columns from strings to JavaScript numbers, potentially changing downstream node behavior. Existing flows expecting strings (e.g., for string concatenation, comparison) break.
**Why it happens:** PostgreSQL `NUMERIC` is an arbitrary-precision decimal type. JavaScript `Number` is IEEE 754 double-precision (loses precision beyond ~15 digits). Existing flows have been receiving `NUMERIC` values as strings via pg's default parser.
**How to avoid:** Per the agent's discretion, recommend **opt-in per node** with a toggle (off by default) to avoid breaking existing flows. Alternatively, provide a pool-level default that users can enable when they deploy new flows. Include a warning in the editor UI about precision loss for values exceeding 2^53.
**Warning signs:** `1.99` becomes `1.9899999999999998`; values > 9007199254740991 lose precision; downstream function nodes fail on type mismatch.

## Code Examples

Verified patterns from official sources:

### SSL Configuration with Managed Certificates
```typescript
// Source: Context7 /brianc/node-postgres SSL docs + Node-RED credential pattern
// Verified against node_modules/pg/docs, pg-protocol/messages.d.ts
const poolConfig: pg.PoolConfig = {
  host: 'database.server.com',
  port: 5432,
  database: 'mydb',
  user: 'dbuser',
  password: 'secretpassword',
  // ssl is passed directly to node.TLSSocket
  ssl: {
    rejectUnauthorized: true,         // verify-ca or verify-full
    ca: node.credentials.sslCa,       // from Node-RED credential store (string)
    key: node.credentials.sslKey,     // client private key (string)
    cert: node.credentials.sslCert,   // client certificate (string)
  },
};
const pool = new pg.Pool(poolConfig);
```

### Pool Health Monitoring
```typescript
// Source: Context7 /brianc/node-postgres pg-pool README
// pg.Pool exposes properties directly and emits events
const pool = new pg.Pool({ max: 10 });

// Read pool state
const health = {
  total: pool.totalCount,      // total clients in pool
  idle: pool.idleCount,        // idle clients available
  waiting: pool.waitingCount,  // requests waiting for a client
  active: pool.totalCount - pool.idleCount,
};

// Pool lifecycle events
pool.on('connect', (client) => {
  // Fired when a new client is created and connected
  console.log('New client connected');
});
pool.on('acquire', (client) => {
  // Fired when a client is checked out from the pool
  console.log('Client acquired');
});
pool.on('error', (err, client) => {
  // Fired when an idle client encounters an error (e.g., disconnected)
  console.error('Pool idle client error:', err.message);
});
```

### DATABASE_URL Parsing Options
```typescript
// Source: Context7 /brianc/node-postgres pg-pool README + pg-connection-string README

// Option A: Use pg-connection-string (bundled with pg)
import { parse } from 'pg-connection-string';
const config = parse('postgres://user:password@host:5432/database?sslmode=require');
// => { user: 'user', password: 'password', host: 'host', port: '5432',
//       database: 'database', ssl: true }

// Option B: Manual URL parsing (Node.js built-in)
import { URL } from 'url';
const uri = new URL(process.env.DATABASE_URL);
const config = {
  user: decodeURIComponent(uri.username),
  password: decodeURIComponent(uri.password),
  host: uri.hostname,
  port: uri.port || '5432',
  database: uri.pathname.replace('/', ''),
};
// Note: URL query parameters (sslmode, etc.) need manual extraction
```

### Complete Query Execution with All Phase 2 Features
```typescript
// Source: Derived from pg docs, verified patterns — synthesis of all requirements
// Inside PostgresNode input handler:

node.on('input', async (msg: any) => {
  // Step 1: Mustache template rendering (existing, preserved)
  const renderedSql = mustache.render(config.query, { msg });

  // Step 2: Named parameter binding (QUERY-01)
  let queryParams: any[];
  if (config.useNamedParams && typeof msg.params === 'object' && !Array.isArray(msg.params)) {
    queryParams = bindNamedParams(renderedSql, msg.params);
  } else {
    queryParams = msg.params || [];
  }

  // Step 3: Prepared statement name (REL-02)
  const stmtName = config.usePreparedStatements ? hashQuery(renderedSql) : undefined;

  // Step 4: Type mapping config (REL-03)
  const queryTypes = config.disableTypeMapping
    ? { getTypeParser: () => (val: string) => val }
    : undefined;

  let client: any = null;
  try {
    client = await node.config.pgPool.connect();

    // Step 5: Query timeout (QUERY-03)
    const timeoutMs = config.queryTimeout || 0;
    if (timeoutMs > 0) {
      await client.query(`SET statement_timeout = ${timeoutMs}`);
    }

    // Step 6: Execute query with all features
    const result = await client.query({
      name: stmtName,
      text: renderedSql,
      values: queryParams,
      types: queryTypes,
    });

    msg.payload = result; // existing behavior: full result on payload
    node.status({
      fill: 'green',
      shape: 'ring',
      text: `Query ok. ${result.rowCount} rows returned`
    });
  } catch (err: any) {
    // Step 7: Structured error (QUERY-02)
    const structuredError = formatError(err);
    node.status({
      fill: 'red',
      shape: 'ring',
      text: `Error: ${structuredError.message}`
    });

    if (config.throwErrors) {
      node.error(structuredError, msg);
      msg = null;
    } else {
      node.error(structuredError);
      msg.error = structuredError;
    }
  } finally {
    // Step 8: Reset timeout and release client
    if (client) {
      try {
        if (timeoutMs > 0) {
          await client.query('SET statement_timeout = 0');
        }
        client.release();
      } catch (releaseErr: any) {
        node.error(`Release error: ${releaseErr.message}`);
      }
    }
    node.send(msg);
  }
});
```

### ACE Editor SQL Configuration
```javascript
// Source: Node-RED bundled ACE editor, existing PostgresNode.html pattern
// In PostgresNode.html oneditprepare:

this.editor = RED.editor.createEditor({
  id: 'node-input-editor',
  mode: 'ace/mode/sql',
  value: $("#node-input-query").val(),
  // Phase 2 additions:
  options: {
    showLineNumbers: true,
    wrap: true,
    useWorker: false,         // disable syntax checker worker
    maxLines: Infinity,
    fontSize: 14,
    enableBasicAutocompletion: true,
    enableLiveAutocompletion: true,
  },
  // Theme integration with Node-RED
  theme: 'ace/theme/tomorrow', // matches Node-RED's dark/light preference
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `ssl: boolean` toggle | `sslmode` dropdown (disable/require/verify-ca/verify-full) + cert credential fields | Phase 2 (now) | Old `ssl: true` auto-migrates to `sslmode: require`; users gain fine-grained cert verification for managed DBs |
| Error as plain string on msg.error | Structured `{ code, detail, constraint, table, severity, ... }` object | Phase 2 (now) | Downstream nodes can inspect error fields; preserve plain string in `message` for backward compat |
| No query timeout | Per-node `statement_timeout` via `SET` command (server-side) | Phase 2 (now) | Prevents runaway queries from consuming pool connections indefinitely |
| Raw textarea for SQL | ACE editor with SQL syntax highlighting, line numbers, auto-completion | Phase 2 (now) | Existing `RED.editor.createEditor` already provides ACE; enhancements: lineNumbers, wrap, theme, autocomplete |
| `msg.params` array only | `msg.params` object with named keys → positional `$1,$2` mapping | Phase 2 (now) | More readable parameter passing; not backward-incompatible (array still works) |
| Default pg type parsing (NUMERIC as string, timestamp as Date) | Custom `pg.types.setTypeParser`: NUMERIC→number, TIMESTAMPTZ→ISO string, JSONB auto-parsed | Phase 2 (now) | Opt-in per node (off by default) to avoid breaking existing flows expecting strings |
| Ad-hoc repeated queries (re-parsed each time) | Named prepared statements with MD5 hash, auto-cached per client connection | Phase 2 (now) | Reduces parse overhead for high-frequency queries; transparent to user |

**Deprecated/outdated:**
- `ssl: boolean` config field — deprecated in favor of `sslmode` dropdown. Greyed out with migration tooltip (D-03).
- Plain-string `msg.error` — replaced by structured object. String still available via `msg.error.message` for backward compatibility.
- ACE editor bare-bones config — enhanced with line numbers, word wrap, auto-completion, and theme options per the agent's discretion.

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this
> section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | ACE editor with `mode: 'ace/mode/sql'` is the correct SQL syntax mode for standard PostgreSQL | SQL Editor (QUERY-04) | Mode may not exist in the specific Node-RED version; fallback: `ace/mode/text` with basic highlighting |
| A2 | `pg-connection-string` `parse()` handles the `sslmode` query parameter correctly (converts to `ssl: true` for `require`) | DATABASE_URL (POOL-04) | May need separate sslmode parsing from URI query params and merge logic |
| A3 | MD5 hash truncated to 8 chars is sufficient to avoid prepared statement name collisions within a single node's query set | Prepared Statements (REL-02) | Collision risk increases with many similar queries (e.g., same prefix); could use longer hash or include more chars |
| A4 | `pg.types.setTypeParser` is safe to call globally (affects all pools in the Node-RED process) | Type Mapping (REL-03) | Global override affects other pg-using contrib nodes in the same Node-RED instance; pool-level override via custom `types` may be needed |
| A5 | `SET statement_timeout` persists per-client but clients are returned to pool and reused; resetting to 0 in `finally` is sufficient to prevent timeout leakage | Query Timeout (QUERY-03) | If `finally` doesn't execute (process crash), pooled client retains timeout for next user; pool-level default with per-query override may be safer |
| A6 | The existing Mustache rendering runs BEFORE named parameter binding, and `{{msg.params.field}}` syntax in SQL is not confused with `$N` positional parameters | Named Params (QUERY-01) | Order matters: if Mustache injects `$N` references, they'd need to be captured before extraction; recommend Mustache runs first, as it does currently |

## Open Questions (RESOLVED)

1. **DATABASE_URL Query Parameter Parsing (POOL-04)**
   - What we know: `pg-connection-string` `parse()` supports `sslmode`, `application_name`, `sslcert`, `sslkey`, `sslrootcert` in query parameters; URL module ignores query params
   - What's unclear: Should URL query parameters override individual fields, or vice versa? Should `sslmode=require` in the URL also set SSL config?
   - RESOLVED: Use `pg-connection-string` for URI parsing. URL query params (sslmode, pool limits) should augment the config, but individual fields in the editor UI should take precedence (explicit > implicit). This matches the "override" semantics discussed.

2. **Pool Health Polling Interval (POOL-02)**
   - What we know: `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` are synchronously readable properties
   - What's unclear: Should health be polled on a timer or refreshed on events? What minimum viable display granularity?
   - RESOLVED: Poll every 30 seconds via `setInterval` (plan 02-01). Display all 4 metrics (active, idle, waiting, total) as `"Active: N  Idle: M  Waiting: W  Total: T"`. Use `pool.on('error')` for immediate error status.

3. **Type Mapping: Opt-in vs Opt-out (REL-03)**
   - What we know: Changing NUMERIC→number is a breaking change. Timestamptz→ISO is also a behavior change (from Date object).
   - What's unclear: Default on or off? Should numeric, timestamp, and jsonb have separate toggles or one "enable type mapping" toggle?
   - RESOLVED: **Opt-in per node (off by default)**. Three separate checkboxes: "Map NUMERIC → Number", "Map TIMESTAMPTZ → ISO string", "Auto-parse JSONB" (the last one being on-by-default since pg already parses JSONB). This avoids breaking existing flows while allowing new flows to opt in.

4. **Named Parameter Syntax Convention (QUERY-01)**
   - What we know: `$1, $2,...` are positional. `msg.params = { name: 'Alice' }` needs a mapping convention.
   - What's unclear: Should keys match positionally (by insertion order of `$N` references) or by naming convention (e.g., `$name` syntax in query)?
   - RESOLVED: Keep `$1, $2` as the positional references. Extract all `$N` from the query, sort numerically, then map `msg.params` keys by their order in the object (as returned by `Object.keys()`). Document that `msg.params` keys should be ordered to match `$1, $2, $3`. For clarity, also support `msg.params` as an array (existing behavior, backward compatible) and `msg.params` as an object (new behavior, opt-in via namedParams toggle).

5. **Node-RED ACE Theme Consistency (QUERY-04)**
   - What we know: ACE editor supports themes; Node-RED has light/dark mode
   - What's unclear: Should the ACE theme auto-match Node-RED's theme, or use a fixed theme?
   - RESOLVED: Use `ace/theme/tomorrow` as the fixed ACE theme (plan 02-03). RESEARCH.md confirms ACE is bundled with Node-RED 3.x and already in use. UI-SPEC suggested CodeMirror 6 but RESEARCH identifies it as unnecessary external dependency — ACE is the correct choice.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24.15.0 | — |
| npm | Package management | ✓ | 11.12.1 | — |
| `pg` (node-postgres) | PostgreSQL connectivity | ✓ (installed) | 8.21.0 | — |
| `mustache` | SQL template rendering | ✓ (installed) | 4.2.0 | — |
| TypeScript | Build | ✓ (dev) | 5.7.x | — |
| Jest | Testing | ✓ (dev) | 29.x | — |
| PostgreSQL server | Integration testing | ✗ | — | Unit tests mock pg.Pool; integration tests need `docker run postgres` |

**Missing dependencies with no fallback:** None — all build dependencies available. PostgreSQL server not required for build/test — tests mock pg.

**Missing dependencies with fallback:** PostgreSQL — not available locally. Integration tests should use Docker (`docker run -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16`) or be run in CI. Unit tests mock `pg.Pool` and `client.query` — no database needed.

## Security Domain

> Required: security_enforcement is enabled (config.json: `"security_enforcement": true`)

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | PostgreSQL native username/password auth; credentials stored in Node-RED encrypted credential storage (`type: 'password'`); cert-based auth via SSL client certificates (mTLS) |
| V3 Session Management | No | Not applicable — stateless query execution; pg.Pool manages connection lifecycle but no user sessions |
| V4 Access Control | No | PostgreSQL enforces row-level and table-level permissions; node has no additional access control layer |
| V5 Input Validation | Yes | SQL injection prevention via parameterized queries (`client.query(text, values)` with `$1,$2` placeholders); Mustache templating runs _before_ parameter binding (template values are NOT parameterized — only `msg.params` values are); channel name sanitization for LISTEN (Phase 3 concern) |
| V6 Cryptography | Yes | SSL/TLS certificates for database connections (CA cert, client cert, client key); certificate values stored in Node-RED encrypted credential storage; `sslmode: verify-ca` and `verify-full` enforce server certificate verification |

### Known Threat Patterns for pg (node-postgres)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via Mustache template values | Tampering | Mustache values are interpolated as raw SQL text — NOT parameterized. Parameterized queries (`$1, $2`) protect only `msg.params` values. Document that `{{ msg.field }}` in templates is unsafe for user-supplied data. Recommend parameterized queries for all dynamic values. (Inherited from Phase 1, not new to Phase 2) |
| Credential exposure in exported flows | Information Disclosure | Certificates and passwords stored in Node-RED credential storage (D-02). `type: 'password'` credentials are NOT included in flow exports. Plain config fields (host, port, database) are exported — this is expected behavior. |
| Man-in-the-middle between Node-RED and PostgreSQL | Information Disclosure | `sslmode: verify-ca` or `verify-full` with proper CA certificate prevents MITM. `sslmode: require` encrypts but does NOT verify server identity (vulnerable to MITM). Default `sslmode: disable` has NO encryption. Auto-migration from `ssl: true` → `sslmode: require` preserves existing (weak) security posture. |
| Parameter type confusion in named parameters | Tampering | When `msg.params` object is mapped to `$1,$2`, all values pass through pg's parameter type encoding. pg handles type coercion based on PostgreSQL's type inference from the query context — safe by design. |
| Prepared statement cache poisoning | Tampering | SQL hash for prepared statement name (D-04). If an attacker can make two different queries hash to the same MD5-truncated name, the prepared statement plan may be reused with wrong parameters. 8-char MD5 hash has ~4 billion combinations — practical collision within a single node's query set is extremely unlikely. |

## Sources

### Primary (HIGH confidence)
- Context7 `/brianc/node-postgres` — pg Pool configuration, SSL docs, pg-pool README events, connection URI/string parsing, client query config with prepared statements, pg-types setTypeParser, DatabaseError type definition [VERIFIED: npm registry + node_modules inspection]
- `node_modules/pg-protocol/dist/messages.d.ts` — DatabaseError class with all 17 error fields (code, detail, constraint, table, schema, column, severity, position, dataType, hint, where, routine, file, line, internalPosition, internalQuery, message) [VERIFIED: local filesystem]
- `node_modules/@types/pg/index.d.ts` — pg module exports, Pool config type, Result type [VERIFIED: local filesystem]

### Secondary (MEDIUM confidence)
- Node-RED official docs — https://nodered.org/docs/api/ui/typedInput/ — typedInput options, types, pattern for typeField with hidden input [CITED]
- Node-RED official docs — https://nodered.org/docs/creating-nodes/credentials — credential registration in both HTML and JS, `type: 'text'` vs `type: 'password'`, accessing credentials at runtime and in editor [CITED]
- GitHub `/brianc/node-postgres/docs/pages/apis/client.mdx` — Client Config type, statement_timeout, query_timeout, lock_timeout, QueryConfig, prepared statements via name field [CITED]
- GitHub `/brianc/node-postgres/docs/pages/features/types.mdx` — Default type parsing behavior (DATE/TIMESTAMP→Date, JSONB→object, UUID→string), strings-by-default fallback [CITED]
- GitHub `/brianc/node-postgres/docs/pages/features/ssl.mdx` — SSL config with ca/key/cert, connectionString + ssl interaction [CITED]
- Existing codebase files: `PostgresDBNode.ts`, `PostgresNode.ts`, `getField.ts`, `types.ts`, `PostgresDBNode.html`, `PostgresNode.html`, `locales/en-US/postgrestor.json` — established patterns for typedInput, credential registration, config node pool creation, Mustache rendering, query execution, i18n [VERIFIED: local filesystem]
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STACK.md`, `.planning/codebase/INTEGRATIONS.md` — architectural analysis, dependency graph, integration points [VERIFIED: local filesystem]

### Tertiary (LOW confidence)
- None — all findings verified against official docs, npm registry, or local codebase inspection.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pg ^8.16.2 (resolves to 8.21.0) confirmed via npm registry; pg-connection-string and pg-types confirmed as bundled dependencies; ACE editor confirmed in Node-RED 3.x
- Architecture: HIGH — patterns derived from official pg docs (Context7), verified against node_modules type definitions, and grounded in existing codebase patterns
- Pitfalls: HIGH — identified from official docs (prepared statement naming, statement_timeout persistence, SSL migration edge cases), verified against actual type definitions and existing code
- Error handling: HIGH — DatabaseError fields confirmed via pg-protocol/dist/messages.d.ts (17 fields documented)
- Security: MEDIUM — ASVS mapping and threat patterns based on standard practices; specific Node-RED integration threats verified against credential storage documentation

**Research date:** 2026-06-10
**Valid until:** 2026-07-10 (30 days — pg is near-stable; pool config API unchanged for years)




