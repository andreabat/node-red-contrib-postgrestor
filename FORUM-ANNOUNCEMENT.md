# [ANNOUNCE] node-red-contrib-postgres v2.0.0 — Full TypeScript PostgreSQL toolkit for Node-RED

After a complete TypeScript rewrite and months of real-world use in production, I'm publishing v2.0.0 of my PostgreSQL node set for Node-RED.

This started as a fork of `node-red-contrib-postgrestor` by doing-things-with-node-red. It has since grown into a production-grade toolkit: three nodes covering everything from simple queries to LISTEN/NOTIFY streaming and bulk COPY operations.

## What's in the box

Three nodes, one config:

- **PostgresDBNode** — Connection config with pool health badge (active / idle / waiting / total visible on the node)
- **PostgresNode** — Execute SQL with Mustache templates, parameterized queries, transactions, cursor streaming, and COPY
- **PostgresListenerNode** — Push real-time `NOTIFY` events into your flow with automatic reconnection

## Features worth mentioning

- **Parameterized queries** via `msg.params` → `$1, $2, ...` (no SQL injection)
- **Named parameters** — `{id: 42, name: "Alice"}` auto-bound in insertion order
- **Mustache templates** — `SELECT * FROM {{msg.table}}` for dynamic table/column names
- **Multi-step transactions** — Pass an array of `{query, params, output}` and get `BEGIN → COMMIT` or `ROLLBACK`
- **Cursor streaming** — `DECLARE / FETCH` large result sets in configurable batches, no memory blowup
- **COPY import/export** — High-speed CSV via PostgreSQL COPY protocol
- **Self-healing retry** — Deadlocks (40P01), serialization failures, and connection drops retry with jittered backoff
- **Full SSL** — `sslmode`, CA cert, client cert/key — RDS, Azure, Supabase ready
- **Structured errors** — `msg.error.code`, `.detail`, `.constraint`, `.table`
- **Query timeout** — Per-node `SET statement_timeout` with guaranteed reset
- **Type mapping** — `NUMERIC→number`, `TIMESTAMPTZ→ISO`, `JSONB→object`
- **Prepared statements** — Auto-named via MD5 hash, zero configuration
- **7 example flows** included in the package

## Why this fork exists

The original `node-red-contrib-postgrestor` was solid but had accumulated bitrot — outdated dependencies, no TypeScript, no tests, and several correctness issues around connection handling and listener reconnection. Rather than patching individual bugs forever, I rewrote the entire thing in TypeScript with 137 Jest tests and a clean architecture. Every feature has test coverage. The listener node no longer silently drops connections.

## Quick example

```
[Inject] → [PostgresDBNode] → [PostgresNode] → [Debug]

PostgresNode SQL:
  INSERT INTO users (name, email) VALUES ($1, $2)
  RETURNING id, name, created_at

Inject payload:
  {"params": ["Jane Doe", "jane@example.com"]}
```

For transactions, just flip the "Transaction Mode" toggle and send an array:

```json
{"payload": [
  {"query": "INSERT INTO users VALUES($1, $2)", "params": {"id": 1, "name": "Ada"}, "output": true},
  {"query": "INSERT INTO logs VALUES($1)", "params": {"action": "user_created"}}
]}
```

## Requirements

- Node.js >= 18
- Node-RED >= 3.0.0
- PostgreSQL — any recent version

## Install

```
npm install @topcs/node-red-contrib-postgres
```

Or use the Palette Manager → search `@topcs/node-red-contrib-postgres`.

## Links

- **GitHub:** https://github.com/andreabat/node-red-contrib-postgres
- **npm:** https://www.npmjs.com/package/@topcs/node-red-contrib-postgres
- **License:** AGPL-3.0

Feedback, bug reports, and PRs welcome. I use this daily in production and intend to maintain it actively.
