# Phase 03: Transactions, Real-time & Streaming - Research

**Researched:** 2026-06-10
**Domain:** PostgreSQL advanced operations — transactions, LISTEN/NOTIFY reconnection, cursor streaming, COPY import/export, retry with backoff
**Confidence:** MEDIUM

## Summary

Phase 3 extends the existing PostgresNode and PostgresListenerNode with four advanced PostgreSQL capabilities, all built on the `pg` 8.16.2 foundation. Transactions use the standard BEGIN/COMMIT/ROLLBACK pattern on a single pool client — well-documented and battle-tested in node-postgres. Cursor streaming (pg-cursor) and COPY bulk operations (pg-copy-streams) are well-supported separate packages from the same maintainer (brianc), though pg-cursor is flagged `[SUS]` due to a very recent publish date (2026-05-18) despite being the official brianc/node-postgres sub-package. Listener reconnection with exponential backoff is a hand-rolled pattern combining Node.js timers and PostgreSQL client events — no library needed. Channel sanitization uses `pg-format` 1.0.4, a mature (9-year-old) package with `%I` identifier escaping identical to PostgreSQL's native `format()`. Retry logic uses error code detection against documented PostgreSQL SQLSTATE classes.

**Primary recommendation:** Add `pg-cursor`, `pg-copy-streams`, and `pg-format` as new runtime dependencies. Implement transaction mode as a config toggle on PostgresNode wrapping the existing query execution in BEGIN/COMMIT/ROLLBACK. Implement reconnection as a recursive retry loop triggered by client `error`/`end` events on PostgresListenerNode. The planner must include `checkpoint:human-verify` tasks before installing `pg-cursor` (flagged `[SUS]`).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Transaction execution (TXN-01, TXN-02) | API / Backend | — | All queries execute server-side via pg.Pool; transaction lifecycle managed in Node.js runtime |
| Listener reconnection (LISTEN-01) | API / Backend | — | Persistent TCP connection to PostgreSQL managed in Node.js event loop |
| Channel name sanitization (LISTEN-02) | API / Backend | — | SQL identifier escaping applied before LISTEN command on server |
| NOTIFY JSON parsing (LISTEN-03) | API / Backend | — | Payload parsing in Node.js runtime before emitting to Node-RED flow |
| Cursor streaming (STREAM-01) | API / Backend | — | DECLARE/FETCH executed server-side; batch emission in runtime |
| COPY CSV import/export (STREAM-02) | API / Backend | — | COPY protocol handled by PostgreSQL; Node.js streams pipe data |
| Retry with backoff (REL-01) | API / Backend | — | Retry loop in Node.js runtime wrapping query/transaction execution |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Transaction mode is opt-in via a config toggle on PostgresNode (`transactionMode`). When ON and `msg.payload` is an array, the node executes all queries atomically within a single client connection. When OFF, `msg.payload` is treated as a single query string (backward compatible).
- **D-02:** Each entry in the transaction array is `{query: string, params: object, output: boolean}`. `query` supports Mustache templating and named parameter binding (same as single-query mode). `params` is optional — uses named parameter binding when provided. `output: true` means that query's result rows go to `msg.payload`. The first query with `output: true` wins (subsequent `output: true` queries are ignored for output purposes).
- **D-03:** On any query failure: auto-ROLLBACK, `msg.error` gets the structured error object (same format as Phase 2 QUERY-02), `msg.payload` stays empty (no partial results), node status shows "Query execution failed". Client is released in `finally` block regardless.
- **D-04:** Both cursor streaming and COPY are implemented. Cursor mode for large SELECT result sets; COPY for bulk CSV import (COPY FROM) and export (COPY TO). Both operate on PostgresNode — no new node type.
- **D-05:** Cursor mode is a per-node config toggle (`cursorMode`). When enabled and a SELECT query is detected, the node uses a PostgreSQL cursor (`DECLARE`/`FETCH`) to stream results in batches. Non-SELECT queries ignore the toggle.
- **D-06:** Cursor output emits each batch as a sequential message: `{payload: [row1, row2, ...], batch: {index: 0, rows: 100, total: N}}`. The final batch is `{payload: [], complete: true, total: N}`. Total row count is included on the first batch when available.
- **D-07:** Listener auto-reconnects on client `error` and `end` events. Reconnection stops only on explicit node `close` (redeploy or node removal) — never gives up.
- **D-08:** Exponential backoff: base 500ms, max 30s, multiplier 2x, with full jitter (`delay = min(30000, 500 * 2^attempt) * Math.random()`). Each attempt updates the node badge.
- **D-09:** Node badge shows connection state: green "listening on {channel}" / yellow "reconnecting (attempt N)" / red "disconnected". State is visible at a glance in the flow editor.
- **D-10:** Retry applies to PostgresNode queries and transactions. Not applied to COPY operations or cursor streaming (these have their own error handling).
- **D-11:** Retry is a per-node toggle (`retryEnabled`) with configurable fields: max retries (default 3), base delay in ms (default 100).
- **D-12:** Transient errors retried: deadlock (40P01), serialization failure (40001), and connection errors (connection reset, refused, terminated). All other errors propagate immediately.
- **D-13:** Retry backoff: base 100ms, max 5s, multiplier 2x, full jitter. After max retries exhausted, error propagates as if retry was disabled.

### the Agent's Discretion

- **Batch size default** — Default cursor batch size (e.g., 100 rows). Whether batch size is a configurable typedInput field or a fixed constant.
- **COPY data flow** — How CSV data enters (msg.payload as string vs. file path vs. buffer) and exits (msg.payload vs. separate file). CSV delimiter/header options (config fields or message properties).
- **Channel sanitization (LISTEN-02)** — Use `pg-format` `%I` for identifier escaping as specified in REQUIREMENTS.md out-of-scope notes. Integration approach (bundled vs. new dependency).
- **NOTIFY JSON parsing (LISTEN-03)** — On-by-default or opt-in toggle. Whether parsed JSON replaces `payload` or goes to a separate `parsedPayload` field. Fallback behavior on invalid JSON.
- **COPY mode trigger** — How COPY vs. cursor is selected when both are available. Separate toggle or auto-detection from SQL content.
- **Retry config fields** — Which typedInput types (num/str/flow/global/env) for max retries and base delay. Whether backoff parameters beyond base delay are configurable or fixed constants.
- **Transaction output semantics** — Edge case: what happens when no query has `output: true` (empty payload? last query result?). Edge case: what about queries that return no rows.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TXN-01 | Multi-step transactions via array-of-queries on msg.payload — each entry {query, params, output} executed atomically on the same client connection | [VERIFIED: Context7 /brianc/node-postgres transactions.mdx] — BEGIN/COMMIT/ROLLBACK on single pool client |
| TXN-02 | Full BEGIN/COMMIT/ROLLBACK lifecycle — auto-ROLLBACK on any query failure, client released in finally | [VERIFIED: Context7 /brianc/node-postgres client.mdx] — getTransactionStatus(), try/catch/finally with release |
| LISTEN-01 | Listener auto-reconnect on connection drop with jittered exponential backoff, stopping only on explicit node close | [CITED: nodered.org/docs/creating-nodes/status] — node status API; [CITED: node-postgres.com/apis/client] — error/end events |
| LISTEN-02 | Channel name sanitized to prevent SQL injection via pg-format identifier escaping | [CITED: npmjs.com/package/pg-format] — format('%I', channel) for SQL identifier escaping |
| LISTEN-03 | NOTIFY payload auto-parsed as JSON when valid, with fallback to raw string | [ASSUMED] — standard JSON.parse pattern with try/catch |
| STREAM-01 | Cursor mode for large result sets via pg-cursor — batched row emission with sequential node.send() calls and completion signal | [VERIFIED: Context7 /brianc/node-postgres cursor.mdx] — Cursor class, cursor.read(rows) batching |
| STREAM-02 | COPY support via pg-copy-streams for high-performance CSV import/export | [VERIFIED: Context7 /brianc/node-pg-copy-streams README] — from()/to() stream factories, pipeline() integration |
| REL-01 | Retry with exponential backoff on transient errors (40P01, 40001, connection reset) | [CITED: postgresql.org/docs/current/errcodes-appendix.html] — SQLSTATE error codes for transient conditions |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pg` | ^8.16.2 | PostgreSQL client with Pool, Client, and notification support | Already in project; official node-postgres by brianc; used by all Phase 2 code |
| `pg-cursor` [WARNING: flagged as suspicious — verify before using.] | 2.20.0 (registry) | Cursor-based result streaming with batched FETCH | Official sub-package of brianc/node-postgres; Submittable interface integrates with client.query(); 1.9M weekly downloads |
| `pg-copy-streams` | 7.0.0 | COPY FROM/TO stream factories for bulk CSV | Official sub-package by brianc; provides from() and to() stream interfaces; 552k weekly downloads |
| `pg-format` | 1.0.4 | SQL identifier and literal escaping (PostgreSQL format() compatible) | 9 years old, 461k weekly downloads; `%I` for identifier escaping matches PostgreSQL native format() |
| `mustache` | ^4.2.0 | Template rendering for SQL queries | Already in project; used in Phase 2 query rendering |
| `pg-connection-string` | ^2.9.1 | DATABASE_URL parsing | Already in project (dep of pg); used by PostgresDBNode |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `stream/promises` | Node built-in | pipeline() for COPY stream management | COPY import/export to reliably pipe data between file and DB streams |
| `@types/pg-format` | latest | TypeScript declarations for pg-format | TypeScript compilation of channel sanitization code (pg-format has external types) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pg-cursor | pg-query-stream | pg-query-stream uses Node.js streams and auto-closes — better for pipe-based workflows but less suitable for Node-RED's message-oriented model. pg-cursor allows precise control over batch sizes and sequential `node.send()` calls, aligning with the CONTEXT.md decision. |
| pg-format | Manual regex sanitization | Hand-rolling identifier escaping is error-prone and incomplete (must handle Unicode, quoted identifiers, special chars). pg-format is PostgreSQL-compatible and well-maintained. |
| custom backoff | `exponential-backoff` npm | A dedicated backoff library offers features like maxDelay and resetOnSuccess, but adds an unnecessary dependency for what is a 3-line function. The project already uses simple utility functions. |

**Installation:**
```bash
npm install pg-cursor@^2.20.0 pg-copy-streams@^7.0.0 pg-format@^1.0.4
npm install --save-dev @types/pg-format
```

**Version verification:** All packages confirmed on npm registry via `npm view` (2026-06-10).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| pg-cursor | npm | ~3 weeks (published 2026-05-18) | 1.9M/wk | github.com/brianc/node-postgres | SUS | Flagged — planner must add checkpoint |
| pg-copy-streams | npm | ~1 year (published 2025-05-27) | 552k/wk | github.com/brianc/node-pg-copy-streams | OK | Approved |
| pg-format | npm | ~9 years (published 2017-02-18) | 644k/wk | github.com/datalanche/node-pg-format | OK | Approved |

**Packages removed due to SLOP verdict:** none

**Packages flagged as suspicious [SUS]:** `pg-cursor` — flagged for "too-new" (published 2026-05-18, ~3 weeks ago). Despite being the official brianc/node-postgres sub-package with 1.9M weekly downloads, the recent publish date triggers the safety gate. The planner must insert a `checkpoint:human-verify` task before `npm install pg-cursor`. Note: This is likely a routine republish of a package that was previously versioned differently — but the verification gate must still be honored as per the package legitimacy protocol.

**Additional note:** CONTEXT.md states "pg-cursor and pg-copy-streams ship with the pg package" — this is incorrect. Both are separate npm packages that must be installed independently. The `pg` package v8.16.2 does not include them as dependencies. This has been confirmed by examining `pg`'s dependency tree and attempting `require('pg-cursor')` without separate installation (throws `MODULE_NOT_FOUND`).

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Node-RED Runtime (RED)                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─ PostgresNode (query node) ────────────────────────────────────┐  │
│  │                                                                 │  │
│  │  msg.payload arrives ──► check config toggles                   │  │
│  │       │                                                         │  │
│  │       ├── transactionMode=on && Array? ──► Transaction Path     │  │
│  │       │      │                                                  │  │
│  │       │      ├── acquire client from pool                       │  │
│  │       │      ├── BEGIN                                          │  │
│  │       │      ├── for each {query, params, output}:              │  │
│  │       │      │    ├── Mustache render → named param bind        │  │
│  │       │      │    ├── client.query()                            │  │
│  │       │      │    └── if output:true → capture result           │  │
│  │       │      ├── COMMIT                                         │  │
│  │       │      ├── ROLLBACK (on error)                            │  │
│  │       │      └── client.release() in finally                    │  │
│  │       │                                                         │  │
│  │       ├── cursorMode=on && SELECT? ──► Cursor Streaming Path    │  │
│  │       │      │                                                  │  │
│  │       │      ├── acquire client from pool                       │  │
│  │       │      ├── DECLARE cursor ... CURSOR FOR query             │  │
│  │       │      ├── loop: FETCH batch_size FROM cursor             │  │
│  │       │      │    └── node.send(batch_msg) per batch             │  │
│  │       │      ├── CLOSE cursor                                   │  │
│  │       │      ├── node.send({complete: true, total: N})          │  │
│  │       │      └── client.release()                                │  │
│  │       │                                                         │  │
│  │       ├── COPY mode? ──► COPY Streaming Path                   │  │
│  │       │      │                                                  │  │
│  │       │      ├── acquire client from pool                       │  │
│  │       │      ├── client.query(copyFrom/To(query))               │  │
│  │       │      ├── pipeline(source, copystream) / pipeline(       │  │
│  │       │      │    copystream, dest)                              │  │
│  │       │      └── client.release() in finally                    │  │
│  │       │                                                         │  │
│  │       └── Default Path (single query, backward compat)          │  │
│  │              │                                                  │  │
│  │              ├── [retryEnabled=on? ──► Retry Loop Wrapper]      │  │
│  │              └── same as Phase 2 flow                            │  │
│  │                                                                 │  │
│  │  Retry Loop (wraps any query/transaction path):                 │  │
│  │    attempt=0; while attempt <= maxRetries:                      │  │
│  │      try { execute; break }                                     │  │
│  │      catch(err):                                                │  │
│  │        if isTransient(err.code) && attempt < maxRetries:        │  │
│  │          delay = min(5000, base*2^attempt)*Math.random()        │  │
│  │          await sleep(delay); attempt++                           │  │
│  │        else throw err                                            │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ PostgresListenerNode ────────────────────────────────────────┐   │
│  │                                                                 │  │
│  │  Deploy ──► listenLoop()                                       │  │
│  │    │                                                            │  │
│  │    ├── attempt = 0                                              │  │
│  │    ├── while !closed:                                           │  │
│  │    │    ├── try:                                                │  │
│  │    │    │    ├── client = await pool.connect()                  │  │
│  │    │    │    ├── await client.query(LISTEN channel)              │  │
│  │    │    │    ├── status: green "listening on {channel}"         │  │
│  │    │    │    ├── client.on('notification', handleNotify)        │  │
│  │    │    │    ├── await new Promise((_,rej)=>                    │  │
│  │    │    │    │    client.on('error', rej);                      │  │
│  │    │    │    │    client.on('end', rej))                         │  │
│  │    │    │    └── (never resolves until error/end/close)          │  │
│  │    │    ├── catch(err):                                         │  │
│  │    │    │    if closed: break                                    │  │
│  │    │    │    status: yellow "reconnecting (attempt N)"          │  │
│  │    │    │    client?.release()                                   │  │
│  │    │    │    delay = min(30000,500*2^attempt)*Math.random()     │  │
│  │    │    │    attempt++                                           │  │
│  │    │    │    await sleep(delay)                                  │  │
│  │    │    └── continue loop                                       │  │
│  │    └── status: red "disconnected"                               │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ PostgresDBNode (config node, no changes) ─────────────────────┐  │
│  │  pg.Pool — shared by PostgresNode + PostgresListenerNode        │  │
│  │  Pool lifecycle: created on deploy, destroyed on close          │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        PostgreSQL Database                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ Transactions  │  │LISTEN/NOTIFY │  │ Cursor DECLARE│              │
│  │ (BEGIN/COMMIT│  │ (async push) │  │ /FETCH/CLOSE  │              │
│  │  /ROLLBACK)   │  │              │  │               │              │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
│  ┌──────────────┐  ┌────────────────────────────────────┐           │
│  │ COPY FROM/TO  │  │  Error codes: 40P01, 40001, 08xxx │           │
│  │ (bulk CSV)   │  │  (transient → retry)               │           │
│  └──────────────┘  └────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
src/
├── nodes/
│   ├── PostgresNode.ts          # Add: transaction, cursor, COPY, retry paths
│   ├── PostgresListenerNode.ts  # Add: reconnection loop, channel sanitization, JSON parse
│   └── PostgresDBNode.ts        # No changes (existing pool works for all modes)
├── lib/
│   ├── params.ts                # Existing: named parameter binding (reused in transactions)
│   ├── errorFormatter.ts        # Existing: structured error formatting (reused in retry)
│   ├── types.ts                 # Add: TransactionQuery, CursorBatch, CopyConfig types
│   ├── typeMapping.ts           # Existing (no changes)
│   ├── getField.ts              # Existing (no changes)
│   └── red.ts                   # Existing (no changes)
└── locales/
    └── en-US/
        └── postgrestor.json     # Add: transaction, cursor, COPY, retry i18n strings
```

### Pattern 1: Transaction Mode (TXN-01, TXN-02)
**What:** Wraps array-of-queries in BEGIN/COMMIT/ROLLBACK on a single pool client
**When to use:** Config toggle `transactionMode` is on AND `msg.payload` is an array
**Example:**
```typescript
// Source: Context7 /brianc/node-postgres docs/pages/features/transactions.mdx
// Adapted for Node-RED message pattern and existing PostgresNode structure

const client = await node.config.pgPool.connect();
try {
  await client.query('BEGIN');
  let outputResult = null;
  
  for (const entry of msg.payload) {
    const renderedQuery = mustache.render(entry.query, { msg });
    const params = entry.params && config.useNamedParams
      ? bindNamedParams(renderedQuery, entry.params)
      : (entry.params || []);
    
    const result = await client.query(renderedQuery, params);
    
    if (entry.output && !outputResult) {
      outputResult = result;  // First output:true wins (D-02)
    }
  }
  
  await client.query('COMMIT');
  msg.payload = outputResult ? outputResult.rows : [];  // If no output:true, empty array
} catch (err) {
  await client.query('ROLLBACK');
  msg.error = formatError(err);
  msg.payload = [];
  node.status({ fill: 'red', shape: 'ring', text: 'Query execution failed' });
} finally {
  client.release();
  node.send(msg);
}
```

### Pattern 2: Cursor Streaming (STREAM-01)
**What:** DECLARE cursor → loop FETCH batch_size → emit per batch → CLOSE → complete signal
**When to use:** Config toggle `cursorMode` is on AND query is SELECT
**Example:**
```typescript
// Source: Context7 /brianc/node-postgres docs/pages/apis/cursor.mdx
import Cursor from 'pg-cursor';

const client = await node.config.pgPool.connect();
try {
  const cursor = client.query(new Cursor(query, params));
  let batchIndex = 0;
  let totalRows = 0;
  let rows;
  
  while ((rows = await cursor.read(batchSize)).length > 0) {
    totalRows += rows.length;
    node.send({
      payload: rows,
      batch: { index: batchIndex, rows: rows.length, total: null },
      ...msg  // preserve other msg properties
    });
    batchIndex++;
  }
  
  // Final completion signal (D-06)
  node.send({
    payload: [],
    complete: true,
    total: totalRows,
    ...msg
  });
} finally {
  client.release();
}
```

### Pattern 3: Listener Reconnection (LISTEN-01)
**What:** Recursive retry loop with jittered exponential backoff on client error/end events
**When to use:** PostgresListenerNode — triggered on client `error` or `end` events
**Example:**
```typescript
// Source: [CITED: nodered.org/docs/creating-nodes/status] for node status API
// Source: [CITED: node-postgres.com/apis/client] for notification/error events
// Backoff formula from D-08

async function listenLoop(node: any, pool: pg.Pool, channel: string) {
  let attempt = 0;
  
  while (!node._closed) {
    let client: pg.PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query(`LISTEN ${channel}`);  // Sanitized via pg-format (LISTEN-02)
      
      // Reset attempt on successful connection
      attempt = 0;
      node.status({
        fill: 'green', shape: 'ring',
        text: `listening on ${channel}`
      });
      
      // Setup notification handler
      const notificationHandler = (msg: pg.Notification) => {
        // LISTEN-03: JSON parse with fallback
        let payload: any = msg.payload;
        try { payload = JSON.parse(msg.payload || ''); } catch {}
        
        node.send({ channel: msg.channel, payload, _original: msg.payload });
      };
      
      client.on('notification', notificationHandler);
      
      // Wait for error or end — blocks until connection drops
      await new Promise<void>((_, reject) => {
        client!.on('error', reject);
        client!.on('end', reject);
      });
    } catch (err) {
      if (node._closed) break;  // Stop on explicit close (D-07)
      
      const delay = Math.min(30000, 500 * Math.pow(2, attempt)) * Math.random();
      node.status({
        fill: 'yellow', shape: 'ring',
        text: `reconnecting (attempt ${attempt + 1})`
      });
      
      attempt++;
      client?.release();
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
}
```

### Pattern 4: Retry Loop (REL-01)
**What:** Wraps query/transaction execution in retry loop for transient errors
**When to use:** Config toggle `retryEnabled` is on (not for COPY or cursor)
**Example:**
```typescript
// Source: [CITED: postgresql.org/docs/current/errcodes-appendix.html] for error codes
// Backoff formula from D-13

const TRANSIENT_CODES = new Set([
  '40P01',  // deadlock_detected
  '40001',  // serialization_failure
  '57P01',  // admin_shutdown
  '57P02',  // crash_shutdown
  '57P03',  // cannot_connect_now
  '08003',  // connection_does_not_exist
  '08006',  // connection_failure
  '08001',  // sqlclient_unable_to_establish_sqlconnection
]);

const CONNECTION_ERROR_PATTERNS = [
  /connection (reset|refused|terminated)/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
];

function isTransientError(err: any): boolean {
  // PostgreSQL SQLSTATE code check
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  // Network-level connection errors (no sqlstate code)
  if (err.message && CONNECTION_ERROR_PATTERNS.some(p => p.test(err.message))) return true;
  return false;
}

async function executeWithRetry(
  operation: () => Promise<void>,
  maxRetries: number,
  baseDelay: number,
  node: any
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await operation();
      return;  // Success
    } catch (err: any) {
      if (attempt < maxRetries && isTransientError(err)) {
        const delay = Math.min(5000, baseDelay * Math.pow(2, attempt)) * Math.random();
        node.log(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;  // Non-transient or max retries exhausted
    }
  }
}
```

### Anti-Patterns to Avoid
- **pool.query() for transactions:** Using `pool.query()` creates different clients per query — PostgreSQL isolates transactions per client. Always use `pool.connect()` for transactions.
- **Forgetting ROLLBACK after error:** A failed query in a transaction leaves the client in error state. Must ROLLBACK to return to idle state before release. Use `client.getTransactionStatus()` to check: 'E' means error state.
- **Cursor without CLOSE:** Cursors hold server resources. Always CLOSE the cursor and release the client. The `finally` block is essential.
- **COPY without pipeline():** Manually piping streams can miss errors on either side. Use `pipeline()` from `stream/promises` for proper error propagation.
- **Unsanitized channel names:** Direct interpolation of channel names into `LISTEN` SQL is SQL injection. Use `format('%I', channel)` from pg-format.
- **Retry on non-transient errors:** Retrying syntax errors or constraint violations wastes time and never succeeds. Only retry on documented transient error codes and connection errors.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL identifier escaping | Custom regex / string replace | `pg-format` `format('%I', name)` | PostgreSQL identifiers follow complex rules (63-byte limit, lowercase folding, unicode, quoted identifiers starting with U&). pg-format implements the full PostgreSQL format() spec. |
| Exponential backoff | Custom while loop with manual delay calc | Inline function using `setTimeout` promise | The formula is simple (3-line function) and doesn't warrant a dependency. But never use linear retry or fixed-interval retry — "thundering herd" on reconnection. |
| Stream piping | Manual `stream.on('data', ...)` + `stream.on('end', ...)` + `stream.on('error', ...)` | `pipeline()` from `node:stream/promises` | pipeline() properly propagates errors and handles cleanup on both sides. Manual piping often misses error paths. |
| JSON parsing with fallback | `JSON.parse()` with error swallowing | `try { JSON.parse(s) } catch { s }` | Simple enough to inline, but must handle null/empty string/undefined gracefully. Use `try/catch` not `JSON.parse(s || '')` — empty string throws. |
| Connection state tracking | Custom state machine | Simple variable + `node.status()` | Node-RED node status is sufficient for the three states (connected/reconnecting/disconnected). No need for a formal state machine. |

**Key insight:** The most dangerous "hand-roll" temptation is SQL identifier escaping. Channel names pass through `LISTEN` which is a SQL command — direct interpolation creates SQL injection. MUST use `pg-format`.

## Runtime State Inventory

> This section is SKIPPED — Phase 3 is a greenfield feature addition, not a rename/refactor/migration phase. No runtime state migration is needed.

## Common Pitfalls

### Pitfall 1: Transaction Client Not Released on Pool Exhaustion
**What goes wrong:** If `client.release()` is not in a `finally` block, any error (including syntax errors, connection drops) leaves the client unreleased. Over multiple failed transactions, the pool exhausts and all queries block.
**Why it happens:** Transaction code has multiple exit paths (success, query failure, ROLLBACK failure). Each path must release.
**How to avoid:** Single `try/catch/finally` with `client.release()` in `finally`. The transaction pattern from node-postgres docs is the canonical template.
**Warning signs:** Pool health badge showing increasing "active" count, "waiting" count > 0.

### Pitfall 2: Cursor Not Closed Before Client Release
**What goes wrong:** Releasing a client without closing the cursor leaves the cursor open on the server, consuming PostgreSQL resources until the session ends.
**Why it happens:** pg-cursor `read()` returns empty array when exhausted, but the cursor itself isn't automatically closed.
**How to avoid:** After the read loop completes (rows.length === 0), explicitly call `cursor.close()` or let the client release trigger cleanup. Better to close explicitly.
**Warning signs:** PostgreSQL `pg_stat_activity` showing idle-in-transaction sessions with open cursors.

### Pitfall 3: Reconnection Loop Without Abort Mechanism
**What goes wrong:** If the close handler doesn't set a flag that the reconnection loop checks, the listener keeps reconnecting even after node removal — connection leak.
**Why it happens:** `setTimeout` callbacks are independent of the Node-RED lifecycle. The close handler runs but the pending timeout fires anyway.
**How to avoid:** Use a `node._closed` flag set in the `close` handler. Check this flag at the top of each reconnection attempt loop iteration and before calling `setTimeout`.
**Warning signs:** Deploying a flow multiple times creates multiple LISTEN connections on the DB; pool badge shows high active count.

### Pitfall 4: Retry on COPY Operations
**What goes wrong:** COPY streams cannot be retried — the stream has already partially consumed data. Retrying a COPY FROM that failed mid-stream would re-send already-imported data, causing duplicates.
**Why it happens:** COPY is stateful (stream position). Restarting the stream loses position information.
**How to avoid:** Per D-10, retry is NOT applied to COPY. Ensure the retry wrapper only applies to query and transaction paths, not the COPY path.
**Warning signs:** Duplicate rows in the target table after a COPY retry.

### Pitfall 5: Channel Name With Special Characters
**What goes wrong:** A channel name like `my-channel` or `user's_channel` breaks the SQL query `LISTEN my-channel` because `-` is not a valid unquoted identifier character.
**Why it happens:** PostgreSQL identifier rules are strict. Channel names are PostgreSQL identifiers.
**How to avoid:** Always escape channel names with `pg-format`: `format('LISTEN %I', channelName)`. This wraps the name in double quotes if needed.
**Warning signs:** Syntax error on LISTEN with dash or special char in channel name.

## Code Examples

Verified patterns from official sources:

### Transaction with Savepoint-Style Error Handling
```typescript
// Source: Context7 /brianc/node-postgres docs/pages/features/transactions.mdx
// Adapted: Single client, try/catch/finally, Mustache + named params per query
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const {query, params, output} of msg.payload) {
    const rendered = mustache.render(query, { msg });
    const bound = params && useNamedParams
      ? bindNamedParams(rendered, params)
      : (params || []);
    await client.query(rendered, bound);
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;  // Structured error handled by caller
} finally {
  client.release();
}
```

### Cursor with Configurable Batch Size
```typescript
// Source: Context7 /brianc/node-postgres docs/pages/apis/cursor.mdx
import Cursor from 'pg-cursor';

const cursor = client.query(new Cursor('SELECT * FROM large_table', []));
const batchSize = 100;
let rows = await cursor.read(batchSize);
while (rows.length > 0) {
  node.send({ payload: rows });
  rows = await cursor.read(batchSize);
}
node.send({ payload: [], complete: true });
```

### COPY FROM with pipeline
```typescript
// Source: Context7 /brianc/node-pg-copy-streams README.md
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const client = await pool.connect();
try {
  const ingestStream = client.query(copyFrom('COPY my_table FROM STDIN CSV HEADER'));
  const csvData = Readable.from([msg.payload]);  // msg.payload as CSV string
  await pipeline(csvData, ingestStream);
  node.status({ fill: 'green', shape: 'ring', text: 'COPY import complete' });
} finally {
  client.release();
}
```

### pg-format Channel Sanitization
```javascript
// Source: [CITED: npmjs.com/package/pg-format README]
const format = require('pg-format');
const safeSql = format('LISTEN %I', channelName);
// If channelName = "my-channel", safeSql = 'LISTEN "my-channel"'
// If channelName = "test"; DROP TABLE users;--", safeSql = 'LISTEN "test""; DROP TABLE users;--"'
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Callback-based pool.connect | async/await pool.connect | pg 8.x (2021) | Existing codebase already uses async/await — consistent |
| pg-cursor 1.x (callback) | pg-cursor 2.x (Promise-based read) | pg-cursor 2.x (~2022) | Must use `await cursor.read(rows)` not callbacks |
| pg-copy-streams callback API | pg-copy-streams with pipeline() + async/await | Node 15+ (stream/promises) | Use `pipeline()` for proper cleanup — existing codebase targets Node >= 18 |
| Manual SQL escaping | pg-format format() | pg-format 1.0 (2017) | PostgreSQL-compatible, no breaking changes; simple API |

**Deprecated/outdated:**
- pg-cursor callback pattern (`cursor.read(rows, callback)`) — use Promise-based `await cursor.read(rows)` with pg-cursor >= 2.x
- Copy streams without pipeline() — Node 15+ provides `stream/promises.pipeline()` for proper error propagation
- Raw channel name interpolation in LISTEN — use `pg-format %I` escaping

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `pg-format` `%I` escaping is identical to PostgreSQL native `format()` and correctly handles all Unicode identifiers | Standard Stack | Medium — would need an alternative escaping mechanism or manual regex, which is error-prone |
| A2 | pg-cursor 2.x `read()` returns Promise (not callback-based) and is compatible with async/await | Standard Stack | Low — confirmed via docs; would revert to callback pattern if wrong |
| A3 | `error.code` on pg errors is a 5-character SQLSTATE string matching PostgreSQL error codes | Architecture Patterns / Retry | Low — confirmed via Context7 and PostgreSQL docs; `error.code` is standard |
| A4 | Connection-level errors (ECONNRESET, ECONNREFUSED) from node-postgres may not have a `.code` property and must be detected via `err.message` pattern matching | Architecture Patterns / Retry | Medium — if node-postgres always provides `.code` for connection errors, the message-matching fallback is unnecessary but harmless |
| A5 | NOTIFY payload is always a string (or null/undefined) in the `msg.payload` field of the notification object | Architecture Patterns / LISTEN-03 | Low — confirmed via Context7 notification type; if binary, fallback to string conversion |
| A6 | Node-RED `node.send()` with multiple sequential calls (not array) emits messages in order through a single output | Architecture Patterns / Cursor | Low — confirmed via Node-RED docs; multi-message sending is standard |
| A7 | pg-cursor 2.20.0 (very recent publish) is the same package as the longstanding pg-cursor from brianc/node-postgres — just a routine republish | Package Legitimacy | Medium — if it's actually a slopsquatted package, the planner's checkpoint will catch it |

## Open Questions (RESOLVED)

1. **pg-cursor SUS verdict — is this a slopsquat or a legitimate republish?**
   - What we know: Published 2026-05-18 on npm, repo is `brianc/node-postgres`, 1.9M weekly downloads, flagged `[SUS]` for "too-new" by legitimacy checker
   - What's unclear: Whether this is a routine maintenance republish or a takeover
   - Recommendation: Planner inserts `checkpoint:human-verify` — human checks the npm page and confirms it's the official brianc package before install

2. **Transaction output when no entry has output:true**
   - What we know: D-02 says first output:true wins. No guidance on the "none" case.
   - What's unclear: Should empty payload, last query result, or all query results be returned?
   - Recommendation: Return empty `msg.payload = []` — safest default, explicitly documented. The planner should handle this in the agent's discretion.

3. **COPY mode vs Cursor mode — how to select when both could apply?**
   - What we know: D-04 says both operate on PostgresNode. D-05 says cursorMode toggle. No COPY toggle specified.
   - What's unclear: Is there a copyMode toggle, or is COPY triggered by SQL content detection (COPY keyword)?
   - Recommendation: Use a dedicated `copyMode` toggle. Auto-detection from SQL content is fragile (COPY can appear in comments, in table names, etc.). Separate toggle is explicit and predictable.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | >= 18 (per engines) | — |
| npm | Package installation | ✓ | shipped with Node | — |
| pg (node-postgres) | All DB operations | ✓ (already in project) | 8.16.2 | — |
| pg-cursor | Cursor streaming (STREAM-01) | ✗ (not installed) | 2.20.0 on npm | Nothing — must install; gated by checkpoint |
| pg-copy-streams | COPY CSV (STREAM-02) | ✗ (not installed) | 7.0.0 on npm | Nothing — must install |
| pg-format | Channel sanitization (LISTEN-02) | ✗ (not installed) | 1.0.4 on npm | Nothing — must install; alternative is manual regex (not recommended) |
| Node.js stream/promises | COPY pipeline management | ✓ | Node 18+ built-in | — |
| TypeScript / tsc | Compilation | ✓ | installed (Phase 1) | — |
| @types/pg-format | TypeScript compilation | ✗ (not installed) | latest on npm | Can use `declare module 'pg-format'` stub |

**Missing dependencies with no fallback:**
- `pg-cursor` — required for STREAM-01 cursor streaming. Gated behind `checkpoint:human-verify`.
- `pg-copy-streams` — required for STREAM-02 COPY support.
- `pg-format` — required for LISTEN-02 channel sanitization.

**Missing dependencies with fallback:**
- `@types/pg-format` — can use a `declare module 'pg-format'` stub in a `.d.ts` file if types unavailable, but strongly prefer installing `@types/pg-format`.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | PostgreSQL native auth via pg.Pool credentials — no changes from Phase 2 |
| V3 Session Management | No | Node-RED manages sessions; this is a contrib node, not a web app |
| V4 Access Control | No | PostgreSQL RBAC enforced server-side; node has no access control layer |
| V5 Input Validation | Yes | Channel names sanitized via pg-format %I identifier escaping; NOTIFY payloads JSON-parsed with try/catch fallback; SQL injection prevention via parameterized queries ($1, $2, etc.) |
| V6 Cryptography | No | SSL/TLS encryption handled by pg.Pool configuration (Phase 2) — no changes |

### Known Threat Patterns for Node.js + PostgreSQL + Node-RED

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via channel name in LISTEN | Tampering | `pg-format('%I', channel)` — identifier escaping prevents injection; channel names are PostgreSQL identifiers, not arbitrary SQL |
| SQL injection via Mustache templates in transaction queries | Tampering | Same as Phase 2 — Mustache coexists with parameterized queries; named parameter binding via `$1,$2` is the safe path. Transaction queries use the same `bindNamedParams` function. |
| Connection exhaustion via listener reconnection storms | Denial of Service | Exponential backoff with full jitter prevents thundering herd on reconnection; max 30s cap prevents runaway delays |
| Unreleased clients from transaction failures | Denial of Service | `finally { client.release() }` pattern guarantees release; pool health badge visible in editor |
| JSON injection via NOTIFY payload | Tampering | NOTIFY payload is a string from PostgreSQL; JSON.parse with try/catch fallback to raw string prevents injection into downstream nodes that consume JSON |
| Retry amplification on non-transient errors | Denial of Service | Retry only on whitelisted transient error codes (40P01, 40001, 08xxx, 57xxx); all other errors propagate immediately; configurable max retries (default 3) |

## Sources

### Primary (HIGH confidence)
- [Context7 /brianc/node-postgres] — Transactions API (BEGIN/COMMIT/ROLLBACK), Cursor API (pg-cursor), LISTEN/NOTIFY events, error handling, client lifecycle
- [Context7 /brianc/node-pg-copy-streams] — COPY FROM/TO stream factories, pipeline integration, async/await patterns
- [node-postgres.com/features/transactions] — Official transaction documentation confirming same-client requirement and try/catch/finally pattern
- [node-postgres.com/apis/cursor] — Official cursor documentation confirming Cursor class and read() API
- [nodered.org/docs/creating-nodes/node-js] — Node-RED node constructor, input handler, send() API, close handler
- [nodered.org/docs/creating-nodes/status] — Node-RED node status API (fill, shape, text)

### Secondary (MEDIUM confidence)
- [npmjs.com/package/pg-format] — pg-format README confirming %I, %L, %s formatting specifiers
- [npm view pg-cursor / pg-copy-streams / pg-format] — Registry verification of package versions and metadata
- [postgresql.org/docs/current/errcodes-appendix.html] — Official PostgreSQL error codes appendix confirming transient error classes (40, 08, 57)

### Tertiary (LOW confidence)
- Exponential backoff with jitter formula — standard industry pattern (AWS Architecture Blog, Google SRE book), confirmed consistent with D-08/D-13 formulas
- Connection error message patterns — based on common node-postgres error messages; may vary by OS and network stack

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages confirmed on npm registry with `npm view`; pg and its sub-packages are the standard PostgreSQL client for Node.js
- Architecture: MEDIUM — transaction and cursor patterns confirmed via official Context7 docs; reconnection and retry patterns are standard but hand-rolled per CONTEXT.md decisions
- Pitfalls: MEDIUM — identified from existing codebase patterns (CONCERNS.md), node-postgres known issues, and Node-RED lifecycle behavior

**Research date:** 2026-06-10
**Valid until:** 2026-07-10 (30 days — stable domain)
