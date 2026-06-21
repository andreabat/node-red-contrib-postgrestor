# Schema Introspection + Editor UX + Magic Wand — Design Spec

- **Date:** 2026-06-21
- **Status:** design approved, pending implementation plan
- **Scope:** Add a schema introspection node, editor UX upgrades (autocomplete, pickers, type hints), and a magic-wand NL-to-SQL feature powered by OpenRouter.

---

## 1. Overview

Three new capabilities added in one coherent workstream:

| Component | Type | What it does |
|-----------|------|--------------|
| `PostgresIntrospectNode` | New runtime node | Queries `information_schema` / `pg_catalog`, builds a structured `SchemaPayload`, caches it on the `PostgresDBNode` config |
| Editor UX upgrades | Changes to existing HTML templates | Query autocomplete (Ctrl+Space), table/column pickers, generate-query button, inline type hints, schema status badge on config |
| Magic Wand | In-editor NL-to-SQL | Natural-language prompt + schema → OpenRouter API → SQL query, reviewed by user before insertion |

All three are tied together by a schema cache stored on the `PostgresDBNode` config — the introspect node populates it, the editor reads it via HTTP admin endpoints, and the magic wand uses it as LLM context.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Node-RED Editor (browser)           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ PostgresNode │  │ PostgresDB   │  │Introspect │ │
│  │  editor HTML │  │ editor HTML  │  │editor HTML│ │
│  │              │  │              │  │           │ │
│  │ ┌──────────┐ │  │              │  │           │ │
│  │ │autocmplt │◄┼──┼──────────────┼──┤           │ │
│  │ │picker    │ │  │              │  │           │ │
│  │ │magic wand│ │  │ schema status│  │           │ │
│  │ └──────────┘ │  │              │  │           │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│         │                  │               │        │
│         │     HTTP admin   │               │        │
│         │  endpoints       │               │        │
└─────────┼──────────────────┼───────────────┼────────┘
          │                  │               │
          ▼                  ▼               ▼
┌─────────────────────────────────────────────────────┐
│     Node-RED Runtime — httpAdmin.ts                 │
│                                                     │
│  GET  /postgres-introspect/schema/:configId          │
│     → returns cached SchemaPayload or {stale:true}   │
│                                                     │
│  POST /postgres-node/generate-query                  │
│     → {prompt, configId} → OpenRouter → {query}     │
│                                                     │
└─────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────┐
│              Node-RED Runtime — nodes               │
│                                                     │
│  PostgresDBNode              PostgresIntrospectNode │
│   (config node)    ◄────────  (new)                 │
│                     populates                       │
│   pgPool                       on input:            │
│   schemaCache {}                 1. query info_schema│
│   _schemaTimestamp               2. cache→config     │
│                                  3. send schema msg  │
└─────────────────────────────────────────────────────┘
```

**Key decisions:**
- Schema lives on the `PostgresDBNode` config, not the introspect node — multiple introspection nodes can share one DB config, and any wired query node can read it.
- Editor-to-runtime bridge is via `RED.httpAdmin` endpoints registered in `src/lib/httpAdmin.ts` (imported by `postgrestor.ts`). No `.js` companion files — the project is pure TypeScript with a `tsc` build step.
- OpenRouter API key is stored as a credential on `PostgresDBNode` — never in plaintext flows.

---

## 3. Data Model

### 3.1 SchemaPayload (output of PostgresIntrospectNode)

```typescript
interface SchemaPayload {
  database: string;
  schema: string;
  version: number;          // PG server version (e.g. 150006)

  tables: Record<string, TableDef>;   // keyed by "schema.table"
  enums: Record<string, EnumDef>;     // keyed by "schema.enum"
}

interface TableDef {
  name: string;
  schema: string;
  columns: ColumnDef[];
  primaryKey: string[];
  foreignKeys: ForeignKeyDef[];
  indexes: IndexDef[];
  estimatedRows?: number;
}

interface ColumnDef {
  name: string;
  type: string;               // pg_type typname: 'int4','varchar','timestamptz'
  nullable: boolean;
  defaultValue?: string;
  isIdentity: boolean;
  isGenerated: boolean;
  maxLength?: number;         // for varchar/char
  enumName?: string;          // if column references an enum
  comment?: string;           // from pg_description
}

interface ForeignKeyDef {
  constraintName: string;
  columns: string[];
  foreignSchema: string;
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  isPrimary: boolean;
  method: string;             // 'btree','gin','gist',etc.
}

interface EnumDef {
  name: string;
  schema: string;
  values: string[];
}
```

**Out of scope for v1:** functions, triggers, views, materialized views, column privileges, partition info.

### 3.2 OpenRouterConfig

```typescript
interface OpenRouterConfig {
  apiKey: string;        // credential — never serialized in flows
  model: string;         // e.g. 'openai/gpt-4o-mini'
  promptStyle: 'concise' | 'balanced' | 'verbose';
}
```

### 3.3 Cache shape on PostgresDBNode

```typescript
// Internal fields added to PostgresDBNode
_schemaCache: SchemaPayload | null;
_schemaTimestamp: number;       // Date.now() when cached
```

---

## 4. PostgresIntrospectNode

### 4.1 Editor properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| PostgresDBNode | config node selector | required | Which DB to introspect |
| schema | text | `public` | Comma-separated schema names |
| cacheTTL | number | `300` | Cache TTL in seconds |
| includeSystemCatalogs | bool | `false` | Include `pg_catalog` / `information_schema` |

### 4.2 Runtime behavior

1. **On input:** Get pool from config → run introspection queries in a single transaction
2. Assemble raw query rows into `SchemaPayload`
3. Write to config: `config._schemaCache = payload`, `config._schemaTimestamp = Date.now()`
4. Send: `msg.payload = SchemaPayload`, `msg.schema`, `msg.database`
5. Status: green `"12 tables, 87 columns"`, yellow if serving from cache, grey if idle

**Refresh logic:**
- `msg.refresh === true` → force re-query, bypass cache
- Otherwise, if cache exists and not expired (`now - timestamp < cacheTTL * 1000`), send cached payload immediately
- Manual inject button forces refresh

### 4.3 Edge cases

| Scenario | Status | Behavior |
|----------|--------|----------|
| Pool unavailable | red `"DB unreachable"` | Structured error output |
| Empty schema | green `"0 tables found"` | `{tables:{}, enums:{}}` |
| Permission denied on info_schema | red | Catch and surface PG error |

### 4.4 Introspection SQL (src/lib/introspect.ts)

Uses `information_schema.columns`, `information_schema.table_constraints` / `key_column_usage`, `pg_index` / `pg_class`, `pg_enum`, `pg_description`. All in a single transaction for consistency.

---

## 5. HTTP Admin Endpoints (src/lib/httpAdmin.ts)

### 5.1 GET `/postgres-introspect/schema/:configId`

Returns the cached `SchemaPayload` for the given config node ID, or `{ stale: true }` if no cache exists.

Used by:
- PostgresNode editor for autocomplete, pickers, type hints
- Config node editor for schema status badge
- Magic Wand for LLM context

### 5.2 POST `/postgres-node/generate-query`

Body: `{ prompt: string, configId: string }`

1. Look up `PostgresDBNode` by `configId`
2. Read `openrouterApiKey` credential and `model` / `promptStyle` from config
3. If no API key configured → 400 `{ error: "No OpenRouter key configured" }`
4. If no schema cached → 400 `{ error: "Schema not loaded — run introspection first" }`
5. Build system prompt from schema + promptStyle
6. POST to `https://openrouter.ai/api/v1/chat/completions`
7. Strip markdown fences from response
8. Return `{ query: string }`

**On error:** return appropriate HTTP status + `{ error: "..." }`.

---

## 6. Editor UX Upgrades

### 6.1 PostgresNode editor (PostgresNode.html)

**Autocomplete** (Ctrl+Space or `.` trigger):
- After `SELECT * FROM ` → suggests table names
- After `FROM orders` → suggests `orders.` columns with type badges
- After `JOIN ` → suggests tables with foreign keys to the FROM table
- Renders type badges: `status (order_status)`, `created_at (timestamptz)`

**Generate Query picker** (button next to textarea):
- Dropdown: "SELECT from...", "INSERT into...", "UPDATE...", "DELETE from..."
- Select table → inserts template query
- INSERT templates exclude identity/generated columns

**Inline type hints** (grey text below textarea, optional):
```
→ columns: id(int4 PK), name(text NOT NULL), status(order_status), created_at(timestamptz)
```
Updates when user types a FROM clause referencing a known table.

### 6.2 Magic Wand (PostgresNode.html)

**UI flow:**
1. Text input: user types NL prompt (e.g. "all orders from last week with customer names")
2. Click **[Generate]** → spinner → response appears below
3. Review generated SQL
4. Click **[Insert]** → replaces query textarea content
5. Click **[Retry]** → regenerate

**Disabled states:**
- No API key → button greyed out, tooltip: "Set OpenRouter key in PostgresDBNode config"
- No schema → button greyed out, tooltip: "Run schema introspection first"

**System prompt** (sent by `POST /postgres-node/generate-query`):
```
You are a PostgreSQL query generator. Given a database schema and a natural
language request, produce ONLY a valid PostgreSQL SQL query. No explanations,
no markdown fences — just the query.

Schema:
- [schema dump from cache]

Rules:
- Use parameterized queries ($1,$2) when the user mentions variable values
- Use table aliases for multi-table queries
- Use COALESCE for nullable columns where sensible
- Never use SELECT * in generated output — list columns explicitly
```

**LLM config:**
- Temperature: 0.1
- Max tokens: 500
- Timeout: 10s

### 6.3 PostgresDBNode editor (PostgresDBNode.html)

**OpenRouter config section:**
| Property | Type | Default |
|----------|------|---------|
| OpenRouter API Key | password (credential) | (empty) |
| AI Model | select | `openai/gpt-4o-mini` |
| AI Prompt Style | select | `balanced` |

**Schema status badge:**
- `"Schema: loaded (12 tables, 87 columns) • 2 min ago"`
- `"Schema: not loaded"` if no cache
- **Refresh Schema** button → triggers introspection

---

## 7. File Changes

| File | Change | Description |
|------|--------|-------------|
| `src/nodes/PostgresIntrospectNode.ts` | **New** | Runtime node — connects to pool, queries info_schema, assembles SchemaPayload, caches on config |
| `src/nodes/PostgresIntrospectNode.html` | **New** | Editor panel — schema selector, cache TTL, inject button |
| `src/lib/introspect.ts` | **New** | SQL query builder — information_schema/pg_catalog queries |
| `src/lib/httpAdmin.ts` | **New** | HTTP admin endpoints: schema fetch + OpenRouter proxy |
| `src/nodes/PostgresDBNode.ts` | **Modified** | Add `_schemaCache` and `_schemaTimestamp` fields |
| `src/nodes/PostgresDBNode.html` | **Modified** | OpenRouter config section (API key, model, prompt style), schema status badge |
| `src/nodes/PostgresNode.html` | **Modified** | Autocomplete, table/column picker, generate-query button, type hints, magic wand UI |
| `src/nodes/PostgresNode.ts` | **No changes** | All editor logic lives in httpAdmin.ts, not in the runtime node |
| `src/lib/types.ts` | **Modified** | Add `SchemaPayload`, `TableDef`, `ColumnDef`, `ForeignKeyDef`, `IndexDef`, `EnumDef`, `OpenRouterConfig` |
| `postgrestor.ts` | **Modified** | Register `PostgresIntrospectNode`, add `openrouterApiKey` to credentials, import and call `httpAdmin.init(RED)` |
| `package.json` | **Modified** | Build script: `cat ... PostgresIntrospectNode.html >> dist/postgrestor.html` |

### 7.1 Credentials update (postgrestor.ts)

```typescript
RED.nodes.registerType('PostgresDBNode', PostgresDBNode, {
  credentials: {
    user: { type: 'text' },
    password: { type: 'password' },
    sslCa: { type: 'password' },
    sslCert: { type: 'password' },
    sslKey: { type: 'password' },
    openrouterApiKey: { type: 'password' }   // new
  }
});
```

### 7.2 Build script update (package.json)

```json
"build": "tsc && cat src/nodes/PostgresDBNode.html src/nodes/PostgresNode.html src/nodes/PostgresListenerNode.html src/nodes/PostgresIntrospectNode.html > dist/postgrestor.html && cp src/nodes/*.html dist/"
```

---

## 8. Test Coverage Targets

### 8.1 PostgresIntrospectNode
- Introspects a PostgreSQL with tables, enums, foreign keys → validates full `SchemaPayload`
- Empty schema → `{ tables: {}, enums: {} }`
- Cache hit → no query issued, timestamp check
- `msg.refresh = true` → bypasses cache
- Pool unavailable → structured error
- includeSystemCatalogs → returns system tables only when enabled

### 8.2 HTTP Admin Endpoints
- `GET /schema/:configId` with valid cache → returns SchemaPayload
- `GET /schema/:configId` with no cache → `{ stale: true }`
- `GET /schema/:configId` with unknown configId → 404
- `POST /generate-query` with valid prompt → returns SQL string
- `POST /generate-query` with no API key → 400
- `POST /generate-query` with no schema → 400
- `POST /generate-query` with OpenRouter error → 502

### 8.3 Schema Introspection SQL (introspect.ts)
- Unit tests: verify generated SQL queries match expected patterns
- Integration test: run against real PostgreSQL → verify output shape

---

## 9. Out of Scope (explicitly deferred)

- Views, materialized views, functions, triggers, partitions
- Streaming/SSE responses from OpenRouter
- Multi-model selection in magic wand UI
- Conversation history / follow-up queries
- Query validation beyond basic SQL fence-stripping
- Schema diffing or migration detection
- Multi-DB schema aggregation (one introspect node per config)
