# Schema Introspection + Editor UX + Magic Wand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a schema introspection node, editor UX upgrades (autocomplete, pickers, type hints), and a magic-wand NL-to-SQL feature backed by OpenRouter.

**Architecture:** Three new capabilities tied together by a schema cache stored on the PostgresDBNode config. A new PostgresIntrospectNode populates the cache by querying `information_schema`/`pg_catalog`. Two HTTP admin endpoints (`GET /postgres-introspect/schema/:configId` and `POST /postgres-node/generate-query`) bridge the editor to the runtime. Editor HTML templates consume the schema for autocomplete, query generation, type hints, and the magic wand NL-to-SQL UI.

**Tech Stack:** TypeScript, Node-RED `RED.httpAdmin`, OpenRouter REST API, PostgreSQL `information_schema` / `pg_catalog`, Jest + ts-jest for tests.

## Global Constraints

- Node.js >= 18.0.0
- Node-RED >= 3.0.0
- Pure TypeScript project with `tsc` build step — no `.js` companion files in `src/`
- OpenRouter API key stored as a credential on PostgresDBNode — never in plaintext flows
- Editor communicates with runtime ONLY via `RED.httpAdmin` endpoints
- All HTML templates concatenated into `dist/postgrestor.html` during build
- Views, materialized views, functions, triggers, partitions are out of scope for v1

---

### Task 1: Type Definitions (types.ts)

**Files:**
- Modify: `src/lib/types.ts`

**Interfaces:**
- Consumes: nothing (pure types, no dependencies)
- Produces: `SchemaPayload`, `TableDef`, `ColumnDef`, `ForeignKeyDef`, `IndexDef`, `EnumDef`, `OpenRouterConfig`

- [ ] **Step 1: Add all new interfaces to types.ts**

Append the following interfaces to `src/lib/types.ts`:

```typescript
export interface SchemaPayload {
  database: string;
  schema: string;
  version: number;

  tables: Record<string, TableDef>;
  enums: Record<string, EnumDef>;
}

export interface TableDef {
  name: string;
  schema: string;
  columns: ColumnDef[];
  primaryKey: string[];
  foreignKeys: ForeignKeyDef[];
  indexes: IndexDef[];
  estimatedRows?: number;
}

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isIdentity: boolean;
  isGenerated: boolean;
  maxLength?: number;
  enumName?: string;
  comment?: string;
}

export interface ForeignKeyDef {
  constraintName: string;
  columns: string[];
  foreignSchema: string;
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  isPrimary: boolean;
  method: string;
}

export interface EnumDef {
  name: string;
  schema: string;
  values: string[];
}

export interface OpenRouterConfig {
  openrouterApiKey: string;
  model: string;
  promptStyle: 'concise' | 'balanced' | 'verbose';
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add SchemaPayload, TableDef, ColumnDef, EnumDef, and OpenRouterConfig types"
```

---

### Task 2: Introspection SQL Query Builder (introspect.ts)

**Files:**
- Create: `src/lib/introspect.ts`
- Create: `src/lib/__tests__/introspect.test.ts`

**Interfaces:**
- Consumes: `SchemaPayload`, `TableDef`, `ColumnDef`, `ForeignKeyDef`, `IndexDef`, `EnumDef` from `src/lib/types.ts` (Task 1)
- Produces: `buildIntrospectionQuery(schema: string, includeSystemCatalogs: boolean): string` — returns a SQL string to run in a transaction
  `assembleSchemaPayload(rows: any[], schemaName: string, pgVersion: number): SchemaPayload` — transforms raw query rows into structured SchemaPayload

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/introspect.test.ts`:

```typescript
import { buildIntrospectionQuery, assembleSchemaPayload } from '../introspect';

describe('buildIntrospectionQuery', () => {
  it('should generate SQL targeting a specific schema', () => {
    const sql = buildIntrospectionQuery('public', false);
    expect(sql).toContain("WHERE nc.nspname = 'public'");
    expect(sql).toContain('information_schema.columns');
    expect(sql).not.toContain('pg_catalog');
  });

  it('should exclude pg_catalog when includeSystemCatalogs is false', () => {
    const sql = buildIntrospectionQuery('public', false);
    expect(sql).toContain("WHERE nc.nspname NOT IN ('information_schema', 'pg_catalog')");
  });

  it('should not filter system catalogs when includeSystemCatalogs is true', () => {
    const sql = buildIntrospectionQuery('public', true);
    expect(sql).not.toContain("nc.nspname NOT IN");
  });

  it('should include enum query', () => {
    const sql = buildIntrospectionQuery('public', false);
    expect(sql).toContain('pg_enum');
    expect(sql).toContain('pg_type');
  });

  it('should include description query for comments', () => {
    const sql = buildIntrospectionQuery('public', false);
    expect(sql).toContain('pg_description');
  });
});

describe('assembleSchemaPayload', () => {
  it('should build a SchemaPayload from raw query rows', () => {
    const rows = [
      // columns
      { table_schema: 'public', table_name: 'users', column_name: 'id',
        data_type: 'integer', is_nullable: 'NO', column_default: "nextval('users_id_seq'::regclass)",
        is_identity: 'NO', is_generated: 'NEVER', character_maximum_length: null,
        udt_name: 'int4', comment: 'Primary key' },
      { table_schema: 'public', table_name: 'users', column_name: 'name',
        data_type: 'character varying', is_nullable: 'NO', column_default: null,
        is_identity: 'NO', is_generated: 'NEVER', character_maximum_length: 255,
        udt_name: 'varchar', comment: null },
      { table_schema: 'public', table_name: 'users', column_name: 'status',
        data_type: 'USER-DEFINED', is_nullable: 'YES', column_default: "'pending'::user_status",
        is_identity: 'NO', is_generated: 'NEVER', character_maximum_length: null,
        udt_name: 'user_status', comment: 'User status enum' },
      // primary keys
      { table_schema: 'public', table_name: 'users', column_name: 'id',
        constraint_type: 'PRIMARY KEY', constraint_name: 'users_pkey' },
      // foreign keys
      { table_schema: 'public', table_name: 'orders', column_name: 'user_id',
        constraint_name: 'orders_user_id_fkey', constraint_type: 'FOREIGN KEY',
        foreign_schema: 'public', foreign_table: 'users', foreign_column: 'id',
        delete_rule: 'CASCADE', update_rule: 'NO ACTION' },
      // indexes (simplified from pg_index join — mock as flat rows)
      { table_schema: 'public', table_name: 'users', index_name: 'users_pkey',
        index_columns: 'id', index_unique: true, index_primary: true,
        index_method: 'btree' },
      // enums
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'pending' },
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'active' },
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'banned' },
    ];

    const result = assembleSchemaPayload(rows, 'public', 150006);

    expect(result.database).toBe('unknown');
    expect(result.schema).toBe('public');
    expect(result.version).toBe(150006);

    // tables
    const users = result.tables['public.users'];
    expect(users).toBeDefined();
    expect(users.name).toBe('users');
    expect(users.columns).toHaveLength(3);
    expect(users.primaryKey).toEqual(['id']);
    expect(users.foreignKeys).toHaveLength(0);
    expect(users.indexes).toHaveLength(1);

    // column details
    const idCol = users.columns.find(c => c.name === 'id')!;
    expect(idCol.type).toBe('int4');
    expect(idCol.nullable).toBe(false);
    expect(idCol.isIdentity).toBe(false);
    expect(idCol.comment).toBe('Primary key');

    const statusCol = users.columns.find(c => c.name === 'status')!;
    expect(statusCol.type).toBe('user_status');
    expect(statusCol.enumName).toBe('user_status');
    expect(statusCol.nullable).toBe(true);

    // orders (only has FK, created from FK data)
    expect(result.tables['public.orders']).toBeDefined();

    // enums
    expect(result.enums['public.user_status'].values).toEqual(['pending', 'active', 'banned']);
  });

  it('should return empty tables/enums for empty rows', () => {
    const result = assembleSchemaPayload([], 'public', 140000);
    expect(result.tables).toEqual({});
    expect(result.enums).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/__tests__/introspect.test.ts --no-coverage
```
Expected: FAIL with "Cannot find module '../introspect'"

- [ ] **Step 3: Implement buildIntrospectionQuery**

Create `src/lib/introspect.ts`:

```typescript
import type { SchemaPayload, TableDef, ColumnDef, ForeignKeyDef, IndexDef, EnumDef } from './types';

export function buildIntrospectionQuery(schema: string, includeSystemCatalogs: boolean): string {
  const schemaFilter = includeSystemCatalogs
    ? `WHERE table_schema IN (${schema.split(',').map(s => `'${s.trim()}'`).join(',')})`
    : `WHERE nc.nspname = '${schema}'`;

  return `
-- Columns
SELECT
  c.table_schema,
  c.table_name,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default,
  c.is_identity,
  c.is_generated,
  c.character_maximum_length,
  c.udt_name,
  d.description AS comment
FROM information_schema.columns c
JOIN pg_class pc ON pc.relname = c.table_name
JOIN pg_namespace nc ON nc.oid = pc.relnamespace AND nc.nspname = c.table_schema
LEFT JOIN pg_description d ON d.objoid = pc.oid AND d.objsubid = c.ordinal_position
${schemaFilter}
ORDER BY c.table_schema, c.table_name, c.ordinal_position;

-- Primary keys
SELECT
  kcu.table_schema,
  kcu.table_name,
  kcu.column_name,
  tc.constraint_type,
  tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
 AND tc.table_name = kcu.table_name
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema = '${schema}';

-- Foreign keys
SELECT
  kcu.table_schema,
  kcu.table_name,
  kcu.column_name,
  tc.constraint_name,
  tc.constraint_type,
  ccu.table_schema AS foreign_schema,
  ccu.table_name AS foreign_table,
  ccu.column_name AS foreign_column,
  rc.delete_rule,
  rc.update_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
 AND tc.table_name = kcu.table_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema = ccu.table_schema
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
 AND tc.constraint_schema = rc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = '${schema}';

-- Indexes
SELECT
  n.nspname AS table_schema,
  c.relname AS table_name,
  i.relname AS index_name,
  array_to_string(array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)), ',') AS index_columns,
  ix.indisunique AS index_unique,
  ix.indisprimary AS index_primary,
  am.amname AS index_method
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_am am ON am.oid = i.relam
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
${includeSystemCatalogs ? '' : "WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')"}
  AND n.nspname = '${schema}'
GROUP BY n.nspname, c.relname, i.relname, ix.indisunique, ix.indisprimary, am.amname

-- Enums
SELECT
  n.nspname AS enum_schema,
  t.typname AS enum_name,
  e.enumlabel AS enum_value
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = '${schema}'
ORDER BY n.nspname, t.typname, e.enumsortorder;
`;
}
```

- [ ] **Step 4: Implement assembleSchemaPayload**

Append to `src/lib/introspect.ts`:

```typescript
interface RawRow {
  // columns
  table_schema?: string;
  table_name?: string;
  column_name?: string;
  data_type?: string;
  is_nullable?: string;
  column_default?: string;
  is_identity?: string;
  is_generated?: string;
  character_maximum_length?: number | null;
  udt_name?: string;
  comment?: string | null;
  // constraints
  constraint_type?: string;
  constraint_name?: string;
  // foreign keys
  foreign_schema?: string;
  foreign_table?: string;
  foreign_column?: string;
  delete_rule?: string;
  update_rule?: string;
  // indexes
  index_name?: string;
  index_columns?: string;
  index_unique?: boolean;
  index_primary?: boolean;
  index_method?: string;
  // enums
  enum_schema?: string;
  enum_name?: string;
  enum_value?: string;
}

export function assembleSchemaPayload(
  rows: RawRow[],
  schemaName: string,
  pgVersion: number
): SchemaPayload {
  const tables: Record<string, TableDef> = {};
  const enums: Record<string, EnumDef> = {};

  // Track which tables we've seen columns for
  const columnTableKeys = new Set<string>();
  const pkColumns: Record<string, string[]> = {};   // "schema.table" → column names
  const fkRows: Record<string, ForeignKeyDef[]> = {};
  const indexRows: Record<string, IndexDef[]> = {};

  for (const row of rows) {
    // ---- Columns ----
    if (row.udt_name !== undefined && row.table_name !== undefined) {
      const key = `${row.table_schema}.${row.table_name}`;
      columnTableKeys.add(key);

      if (!tables[key]) {
        tables[key] = {
          name: row.table_name,
          schema: row.table_schema || '',
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
        };
      }

      const col: ColumnDef = {
        name: row.column_name || '',
        type: row.udt_name || row.data_type || 'unknown',
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default || undefined,
        isIdentity: row.is_identity === 'YES',
        isGenerated: row.is_generated === 'ALWAYS',
        maxLength: row.character_maximum_length ?? undefined,
        enumName: row.data_type === 'USER-DEFINED' ? row.udt_name : undefined,
        comment: row.comment || undefined,
      };
      tables[key].columns.push(col);
    }

    // ---- Primary keys ----
    if (row.constraint_type === 'PRIMARY KEY') {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!pkColumns[key]) pkColumns[key] = [];
      pkColumns[key].push(row.column_name || '');
    }

    // ---- Foreign keys ----
    if (row.constraint_type === 'FOREIGN KEY') {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!fkRows[key]) fkRows[key] = [];

      const existing = fkRows[key].find(fk => fk.constraintName === row.constraint_name);
      if (existing) {
        existing.columns.push(row.column_name || '');
        existing.foreignColumns.push(row.foreign_column || '');
      } else {
        fkRows[key].push({
          constraintName: row.constraint_name || '',
          columns: [row.column_name || ''],
          foreignSchema: row.foreign_schema || '',
          foreignTable: row.foreign_table || '',
          foreignColumns: [row.foreign_column || ''],
          onDelete: row.delete_rule || '',
          onUpdate: row.update_rule || '',
        });
      }

      // Ensure the referenced table exists in our schema output
      const fkTableKey = `${row.foreign_schema}.${row.foreign_table}`;
      if (!tables[fkTableKey]) {
        tables[fkTableKey] = {
          name: row.foreign_table || '',
          schema: row.foreign_schema || '',
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
        };
      }
    }

    // ---- Indexes ----
    if (row.index_name !== undefined) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!indexRows[key]) indexRows[key] = [];
      indexRows[key].push({
        name: row.index_name || '',
        columns: (row.index_columns || '').split(','),
        unique: row.index_unique || false,
        isPrimary: row.index_primary || false,
        method: row.index_method || 'btree',
      });
    }

    // ---- Enums ----
    if (row.enum_name !== undefined) {
      const key = `${row.enum_schema}.${row.enum_name}`;
      if (!enums[key]) {
        enums[key] = {
          name: row.enum_name || '',
          schema: row.enum_schema || '',
          values: [],
        };
      }
      enums[key].values.push(row.enum_value || '');
    }
  }

  // Apply PK, FK, and indexes to their tables
  for (const key of Object.keys(tables)) {
    if (pkColumns[key]) {
      tables[key].primaryKey = pkColumns[key];
    }
    if (fkRows[key]) {
      tables[key].foreignKeys = fkRows[key];
    }
    if (indexRows[key]) {
      tables[key].indexes = indexRows[key];
    }
  }

  return {
    database: 'unknown',
    schema: schemaName,
    version: pgVersion,
    tables,
    enums,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest src/lib/__tests__/introspect.test.ts --no-coverage
```
Expected: 7/7 tests pass.

- [ ] **Step 6: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/introspect.ts src/lib/__tests__/introspect.test.ts
git commit -m "feat: add introspection SQL query builder and SchemaPayload assembler"
```

---

### Task 3: PostgresDBNode Schema Cache Fields

**Files:**
- Modify: `src/nodes/PostgresDBNode.ts`
- Modify: `src/nodes/__tests__/PostgresDBNode.test.ts`

**Interfaces:**
- Consumes: `SchemaPayload` from `src/lib/types.ts` (Task 1)
- Produces: `_schemaCache: SchemaPayload | null` and `_schemaTimestamp: number` fields on PostgresDBNode instances

- [ ] **Step 1: Write the failing test**

Append to `src/nodes/__tests__/PostgresDBNode.test.ts`:

```typescript
describe('schema cache fields', () => {
  it('should expose _schemaCache initialized to null', () => {
    const config: any = {
      name: 'test', host: 'localhost', hostFieldType: 'str',
      port: '5432', portFieldType: 'num', database: 'mydb', databaseFieldType: 'str',
      ssl: 'false', sslFieldType: 'bool', sslmode: 'disable', sslmodeFieldType: 'str',
      databaseUrl: '', databaseUrlFieldType: 'str', useDatabaseUrl: 'false',
      statementTimeout: '0', statementTimeoutFieldType: 'num',
      max: '5', maxFieldType: 'num', min: '2', minFieldType: 'num',
      idle: '5000', idleFieldType: 'num',
      connectionTimeout: '3000', connectionTimeoutFieldType: 'num',
      throwErrors: 'true', throwErrorsFieldType: 'bool',
      user: '', userFieldType: 'str', password: '', passwordFieldType: 'str'
    };
    const context: any = {
      context: () => ({ flow: { get: () => undefined }, global: { get: () => undefined } }),
      debug: jest.fn(), warn: jest.fn(), on: jest.fn(), status: jest.fn(),
      credentials: { user: undefined, password: undefined }
    };
    const boundFn = PostgresDBNode.bind(context, config);
    boundFn();

    expect(context._schemaCache).toBeNull();
    expect(typeof context._schemaTimestamp).toBe('number');
    expect(context._schemaTimestamp).toBe(0);
  });
});
```

Include the test import at the top of the file if not already present; add to the existing describe block at the end.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/nodes/__tests__/PostgresDBNode.test.ts --no-coverage -t "schema cache fields"
```
Expected: FAIL — `_schemaCache` is `undefined`

- [ ] **Step 3: Add schema cache fields to PostgresDBNode**

In `src/nodes/PostgresDBNode.ts`, after the `node.throwErrorsFieldType = n.throwErrorsFieldType;` line (line 42), add:

```typescript
  // Schema cache — populated by PostgresIntrospectNode, consumed by editor via HTTP admin
  node._schemaCache = null;
  node._schemaTimestamp = 0;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/nodes/__tests__/PostgresDBNode.test.ts --no-coverage -t "schema cache fields"
```
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npx jest --no-coverage
```
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/nodes/PostgresDBNode.ts src/nodes/__tests__/PostgresDBNode.test.ts
git commit -m "feat: add _schemaCache and _schemaTimestamp fields to PostgresDBNode"
```

---

### Task 4: PostgresIntrospectNode Runtime

**Files:**
- Create: `src/nodes/PostgresIntrospectNode.ts`
- Create: `src/nodes/__tests__/PostgresIntrospectNode.test.ts`

**Interfaces:**
- Consumes: `PostgresDBNodeConfig`, `SchemaPayload`, `StructuredError` from `src/lib/types.ts` (Task 1)
- Consumes: `buildIntrospectionQuery`, `assembleSchemaPayload` from `src/lib/introspect.ts` (Task 2)
- Consumes: `getREDNodes`, `setRED` from `src/lib/red.ts`
- Consumes: `formatError` from `src/lib/errorFormatter.ts`
- Produces: `PostgresIntrospectNode(config: PostgresIntrospectNodeConfig)` — a Node-RED node constructor

- [ ] **Step 1: Write the failing test**

Create `src/nodes/__tests__/PostgresIntrospectNode.test.ts`:

```typescript
const mockPoolConnect = jest.fn().mockResolvedValue({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  release: jest.fn()
});
const mockPool = { connect: mockPoolConnect };
const mockPoolConstructor = jest.fn(() => mockPool);

jest.mock('pg', () => ({ Pool: mockPoolConstructor }));

jest.mock('../../lib/red', () => {
  const actual = jest.requireActual('../../lib/red');
  return { ...actual };
});

import { PostgresIntrospectNode } from '../PostgresIntrospectNode';
import { setRED } from '../../lib/red';

describe('PostgresIntrospectNode', () => {
  let redRuntime: any;
  let nodeInstance: any;
  let mockConfigNode: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConfigNode = {
      pgPool: { connect: mockPoolConnect },
      _schemaCache: null,
      _schemaTimestamp: 0,
      name: 'test-db',
    };

    redRuntime = {
      nodes: {
        createNode: jest.fn(),
        registerType: jest.fn(),
        getNode: jest.fn().mockReturnValue(mockConfigNode),
      }
    };
    setRED(redRuntime);
  });

  describe('node construction', () => {
    it('should create node via RED.createNode', () => {
      const config: any = {
        name: 'introspector',
        PostgresDBNode: 'config-id-1',
        schema: 'public',
        cacheTTL: '300',
        includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
        on: jest.fn(),
      };
      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();

      expect(redRuntime.nodes.createNode).toHaveBeenCalledWith(context, config);
    });
  });

  describe('input handling', () => {
    it('should send cached SchemaPayload when cache is fresh (no query)', async () => {
      const cachedPayload: any = {
        database: 'testdb', schema: 'public', version: 150006,
        tables: {}, enums: {}
      };
      mockConfigNode._schemaCache = cachedPayload;
      mockConfigNode._schemaTimestamp = Date.now(); // fresh

      const config: any = {
        name: 'introspector',
        PostgresDBNode: 'config-id-1',
        schema: 'public',
        cacheTTL: '300',
        includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        status: jest.fn(),
        send: jest.fn(),
        on: jest.fn(),
      };

      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();

      // Trigger input
      const msg = { payload: 'trigger' };
      context._inputHandler(msg);

      // Allow async to flush
      await new Promise(r => setTimeout(r, 10));

      expect(context.send).toHaveBeenCalledWith(expect.objectContaining({
        payload: cachedPayload,
        schema: 'public',
        database: 'testdb',
      }));
      expect(mockPoolConnect).not.toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'yellow', shape: 'ring' })
      );
    });

    it('should force refresh when msg.refresh is true (bypass cache)', async () => {
      const cachedPayload: any = { database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {} };
      mockConfigNode._schemaCache = cachedPayload;
      mockConfigNode._schemaTimestamp = Date.now();

      const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
      const mockClient = { query: mockQuery, release: jest.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const config: any = {
        name: 'introspector', PostgresDBNode: 'config-id-1',
        schema: 'public', cacheTTL: '300', includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
        status: jest.fn(), send: jest.fn(), on: jest.fn(),
      };

      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();

      context._inputHandler({ refresh: true });
      await new Promise(r => setTimeout(r, 10));

      expect(mockPoolConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'green', shape: 'ring' })
      );
    });

    it('should handle pool unavailable with structured error', async () => {
      mockPoolConnect.mockRejectedValue(new Error('Connection refused'));

      const config: any = {
        name: 'introspector', PostgresDBNode: 'config-id-1',
        schema: 'public', cacheTTL: '300', includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
        status: jest.fn(), send: jest.fn(), on: jest.fn(),
      };

      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();

      context._inputHandler({});
      await new Promise(r => setTimeout(r, 10));

      expect(context.error).toHaveBeenCalled();
      expect(context.send).toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'red', shape: 'ring' })
      );
    });
  });

  describe('close handler', () => {
    it('should clear status on close', () => {
      const config: any = {
        name: 'introspector', PostgresDBNode: 'config-id-1',
        schema: 'public', cacheTTL: '300', includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
        status: jest.fn(), send: jest.fn(), on: jest.fn(),
      };

      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();

      // Find and invoke the close handler
      const closeHandler = context.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
      expect(closeHandler).toBeDefined();
      closeHandler();

      expect(context.status).toHaveBeenCalledWith({});
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/nodes/__tests__/PostgresIntrospectNode.test.ts --no-coverage
```
Expected: FAIL with "Cannot find module '../PostgresIntrospectNode'"

- [ ] **Step 3: Implement PostgresIntrospectNode**

Create `src/nodes/PostgresIntrospectNode.ts`:

```typescript
import { getREDNodes } from '../lib/red';
import { formatError } from '../lib/errorFormatter';
import { buildIntrospectionQuery, assembleSchemaPayload } from '../lib/introspect';
import type { PostgresDBNodeConfig, SchemaPayload } from '../lib/types';

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
  const includeSystemCatalogs = config.includeSystemCatalogs === 'true' || config.includeSystemCatalogs === true;

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest src/nodes/__tests__/PostgresIntrospectNode.test.ts --no-coverage
```
Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/nodes/PostgresIntrospectNode.ts src/nodes/__tests__/PostgresIntrospectNode.test.ts
git commit -m "feat: add PostgresIntrospectNode — queries info_schema, caches SchemaPayload on config"
```

---

### Task 5: PostgresIntrospectNode Editor HTML

**Files:**
- Create: `src/nodes/PostgresIntrospectNode.html`

**Interfaces:**
- Consumes: nothing (editor-only, self-contained)
- Produces: Node-RED editor registration for `PostgresIntrospectNode`

- [ ] **Step 1: Create the editor HTML template**

Create `src/nodes/PostgresIntrospectNode.html`:

```html
<script type="text/x-red" data-template-name="PostgresIntrospectNode">
  <div class="form-row">
    <label for="node-input-name">
      <i class="icon-tag"></i>
      <span data-i18n="postgres.label.name"></span>
    </label>
    <input type="text" id="node-input-name" data-i18n="[placeholder]node-red:common.label.name">
  </div>
  <div class="form-row">
    <label for="node-input-PostgresDBNode">
      <i class="fa fa-server"></i>
      <span data-i18n="postgres.label.server"></span>
    </label>
    <input type="text" id="node-input-PostgresDBNode">
  </div>
  <div class="form-row">
    <label for="node-input-schema">
      <span data-i18n="postgres.label.introspectSchema">Schema</span>
    </label>
    <input type="text" id="node-input-schema" placeholder="public">
  </div>
  <div class="form-row">
    <label for="node-input-cacheTTL">
      <span data-i18n="postgres.label.cacheTTL">Cache TTL (seconds)</span>
    </label>
    <input type="number" id="node-input-cacheTTL" placeholder="300" min="0">
  </div>
  <div class="form-row">
    <input type="checkbox" id="node-input-includeSystemCatalogs" style="display: inline-block; width: auto; vertical-align: top;">
    <label for="node-input-includeSystemCatalogs">
      <span data-i18n="postgres.label.includeSystemCatalogs">Include system catalogs (pg_catalog, information_schema)</span>
    </label>
  </div>
  <div class="form-row">
    <button id="node-input-refresh-schema" class="red-ui-button">
      <i class="fa fa-refresh"></i> Refresh Schema Now
    </button>
  </div>
</script>

<script type="text/javascript">
  RED.nodes.registerType("PostgresIntrospectNode", {
    category: "storage",
    color: 'rgb(5, 93, 193)',
    defaults: {
      name: { value: "" },
      PostgresDBNode: { type: "PostgresDBNode", required: true },
      schema: { value: "public" },
      cacheTTL: { value: 300, validate: RED.validators.number() },
      includeSystemCatalogs: { value: false },
    },
    inputs: 1,
    outputs: 1,
    icon: "db.png",
    align: "left",
    label: function () {
      return this.name || "schema introspect";
    },
    labelStyle: function () {
      return this.name ? "node_label_italic" : "";
    },
    oneditprepare: function () {
      $("#node-input-includeSystemCatalogs").prop("checked",
        this.includeSystemCatalogs === true || this.includeSystemCatalogs === 'true');
    },
    oneditsave: function () {}
  });
</script>

<script type="text/x-red" data-help-name="PostgresIntrospectNode">
    <h3>PostgresIntrospectNode — Schema Introspection</h3>
    <p>Queries <code>information_schema</code> and <code>pg_catalog</code> to build a
    structured schema representation of your database. Caches the result on the
    PostgresDBNode config for use by other nodes and the editor.</p>

    <h4>Configuration</h4>
    <dl>
      <dt><b>Name</b></dt><dd>Label for this node in the flow.</dd>
      <dt><b>Server</b></dt><dd>Select a PostgresDBNode that defines the database connection.</dd>
      <dt><b>Schema</b></dt><dd>PostgreSQL schema to introspect. Default: <code>public</code>.</dd>
      <dt><b>Cache TTL (seconds)</b></dt><dd>How long the schema stays cached before a refresh. Default: 300 (5 min). Set to 0 to always re-query.</dd>
      <dt><b>Include system catalogs</b></dt><dd>When enabled, includes <code>pg_catalog</code> and <code>information_schema</code> tables. Off by default.</dd>
    </dl>

    <h4>Input</h4>
    <p>Any message triggers introspection. Send <code>msg.refresh = true</code> to bypass the cache and force a re-query.</p>

    <h4>Output</h4>
    <ul>
      <li><code>msg.payload</code> — <code>SchemaPayload</code> with tables, columns, FKs, indexes, enums</li>
      <li><code>msg.schema</code> — schema name (e.g. "public")</li>
      <li><code>msg.database</code> — database name</li>
    </ul>

    <h4>Status Badge</h4>
    <ul>
      <li>🟢 <b>12 tables, 87 columns</b> — fresh introspection complete</li>
      <li>🟡 <b>Serving from cache</b> — returning cached data</li>
      <li>🔴 <b>DB unreachable</b> — connection failed</li>
    </ul>
</script>
```

- [ ] **Step 2: Verify the HTML is well-formed (no build needed yet)**

```bash
cat src/nodes/PostgresIntrospectNode.html | grep -c '<script'
```
Expected: `3` (template, registration, help)

- [ ] **Step 3: Commit**

```bash
git add src/nodes/PostgresIntrospectNode.html
git commit -m "feat: add PostgresIntrospectNode editor HTML template with schema selector, cache TTL"
```

---

### Task 6: HTTP Admin Endpoints (httpAdmin.ts)

**Files:**
- Create: `src/lib/httpAdmin.ts`
- Create: `src/lib/__tests__/httpAdmin.test.ts`

**Interfaces:**
- Consumes: `getREDNodes` from `src/lib/red.ts`
- Consumes: `SchemaPayload`, `OpenRouterConfig` from `src/lib/types.ts` (Task 1)
- Produces: `export function init(RED: any): void` — registers HTTP admin endpoints
  - `GET /postgres-introspect/schema/:configId` — returns cached SchemaPayload or `{ stale: true }`
  - `POST /postgres-node/generate-query` — body `{ prompt, configId }` → OpenRouter → `{ query }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/httpAdmin.test.ts`:

```typescript
import { init } from '../httpAdmin';

// We'll mock the RED object directly since httpAdmin endpoints are registered via RED.httpAdmin
describe('httpAdmin init', () => {
  it('should be a function that accepts a RED runtime', () => {
    expect(typeof init).toBe('function');
    expect(init.length).toBe(1); // takes one arg: RED
  });
});

describe('GET /postgres-introspect/schema/:configId', () => {
  let mockRED: any;
  let routes: Record<string, { method: string; handler: Function }> = {};

  beforeEach(() => {
    routes = {};
    mockRED = {
      httpAdmin: {
        get: jest.fn((path: string, handler: Function) => {
          routes['GET ' + path] = { method: 'GET', handler };
        }),
        post: jest.fn((path: string, handler: Function) => {
          routes['POST ' + path] = { method: 'POST', handler };
        }),
      },
      nodes: {
        getNode: jest.fn(),
      },
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    };
    init(mockRED);
  });

  it('should register the GET schema endpoint', () => {
    expect(mockRED.httpAdmin.get).toHaveBeenCalledWith(
      '/postgres-introspect/schema/:configId',
      expect.any(Function)
    );
  });

  it('should return { stale: true } when config node has no cache', async () => {
    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
    const mockReq = { params: { configId: 'nonexistent' } };

    mockRED.nodes.getNode.mockReturnValue(null);

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ stale: true });
  });

  it('should return cached SchemaPayload when available', async () => {
    const cached: any = { database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {} };
    const mockConfigNode = {
      _schemaCache: cached,
      _schemaTimestamp: Date.now(),
    };

    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
    const mockReq = { params: { configId: 'config-1' } };

    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith(cached);
  });

  it('should return { stale: true } when config node exists but cache is null', async () => {
    const mockConfigNode = { _schemaCache: null, _schemaTimestamp: 0 };
    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
    const mockReq = { params: { configId: 'config-1' } };

    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ stale: true });
  });
});

describe('POST /postgres-node/generate-query', () => {
  let mockRED: any;
  let routes: Record<string, { method: string; handler: Function }> = {};
  let mockFetch: jest.Mock;

  beforeEach(() => {
    routes = {};
    mockFetch = jest.fn();

    // @ts-ignore — assign global fetch mock
    globalThis.fetch = mockFetch;

    mockRED = {
      httpAdmin: {
        get: jest.fn((path: string, handler: Function) => {
          routes['GET ' + path] = { method: 'GET', handler };
        }),
        post: jest.fn((path: string, handler: Function) => {
          routes['POST ' + path] = { method: 'POST', handler };
        }),
      },
      nodes: {
        getNode: jest.fn(),
      },
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    };
    init(mockRED);
  });

  afterEach(() => {
    // @ts-ignore
    delete globalThis.fetch;
  });

  it('should register the POST generate-query endpoint', () => {
    expect(mockRED.httpAdmin.post).toHaveBeenCalledWith(
      '/postgres-node/generate-query',
      expect.any(Function)
    );
  });

  it('should return 400 when no API key is configured', async () => {
    const mockConfigNode = {
      _schemaCache: { tables: {}, enums: {} },
      credentials: {},
    };
    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['POST /postgres-node/generate-query']?.handler;
    const mockReq = { body: { prompt: 'test', configId: 'config-1' } };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ error: expect.stringContaining('OpenRouter') });
  });

  it('should return 400 when no schema is cached', async () => {
    const mockConfigNode = {
      _schemaCache: null,
      credentials: { openrouterApiKey: 'sk-test' },
    };
    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['POST /postgres-node/generate-query']?.handler;
    const mockReq = { body: { prompt: 'test', configId: 'config-1' } };

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ error: expect.stringContaining('Schema not loaded') });
  });

  it('should call OpenRouter and return generated SQL', async () => {
    const mockConfigNode = {
      _schemaCache: {
        database: 'testdb', schema: 'public', version: 150000,
        tables: { 'public.users': { name: 'users', schema: 'public', columns: [
          { name: 'id', type: 'int4', nullable: false, isIdentity: true, isGenerated: false },
        ], primaryKey: ['id'], foreignKeys: [], indexes: [] } },
        enums: {},
      },
      credentials: { openrouterApiKey: 'sk-test-key' },
      openrouterApiKey: 'sk-test-key',
      model: 'openai/gpt-4o-mini',
      promptStyle: 'balanced',
    };
    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'SELECT id FROM users;' } }],
      }),
    });

    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['POST /postgres-node/generate-query']?.handler;
    const mockReq = { body: { prompt: 'select all users', configId: 'config-1' } };

    await handler(mockReq, mockRes);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer sk-test-key',
        }),
      })
    );
    expect(mockRes.json).toHaveBeenCalledWith({ query: 'SELECT id FROM users;' });
  });

  it('should strip markdown fences from LLM response', async () => {
    const mockConfigNode = {
      _schemaCache: { database: 'testdb', schema: 'public', version: 150000, tables: {}, enums: {} },
      credentials: { openrouterApiKey: 'sk-test' },
      openrouterApiKey: 'sk-test',
      model: 'openai/gpt-4o-mini',
      promptStyle: 'balanced',
    };
    mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        choices: [{ message: { content: '```sql\nSELECT 1;\n```' } }],
      }),
    });

    const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const handler = routes['POST /postgres-node/generate-query']?.handler;
    const mockReq = { body: { prompt: 'test', configId: 'config-1' } };

    await handler(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledWith({ query: 'SELECT 1;' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/lib/__tests__/httpAdmin.test.ts --no-coverage
```
Expected: FAIL with "Cannot find module '../httpAdmin'"

- [ ] **Step 3: Implement httpAdmin.ts**

Create `src/lib/httpAdmin.ts`:

```typescript
import { getREDNodes, getRED } from './red';
import type { SchemaPayload } from './types';

/**
 * Build the system prompt for OpenRouter based on schema and prompt style.
 */
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

    const enums = schema.enums;
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

  if (style === 'concise') {
    return base + '\n- Keep queries as short as possible';
  }
  if (style === 'verbose') {
    return base + '\n- Add brief SQL comments explaining joins and filters';
  }
  return base; // balanced
}

/**
 * Strip markdown code fences from LLM output.
 */
function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:sql)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Register HTTP admin endpoints.
 */
export function init(_RED?: any): void {
  // If RED is passed directly, use it; otherwise get from stored runtime
  const RED = _RED || getRED();
  if (!RED) return;

  // GET /postgres-introspect/schema/:configId
  // Returns cached SchemaPayload or { stale: true }
  RED.httpAdmin.get('/postgres-introspect/schema/:configId', (req: any, res: any) => {
    const configNode = RED.nodes.getNode(req.params.configId);
    if (!configNode || !configNode._schemaCache) {
      return res.json({ stale: true });
    }
    return res.json(configNode._schemaCache);
  });

  // POST /postgres-node/generate-query
  // Body: { prompt: string, configId: string }
  // Returns: { query: string } or { error: string } with HTTP status
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

      if (!configNode._schemaCache) {
        return res.status(400).json({ error: 'Schema not loaded — run introspection first. Add a PostgresIntrospectNode to your flow.' });
      }

      const model = configNode.model || 'openai/gpt-4o-mini';
      const promptStyle = configNode.promptStyle || 'balanced';

      const systemPrompt = buildSystemPrompt(configNode._schemaCache, promptStyle);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest src/lib/__tests__/httpAdmin.test.ts --no-coverage
```
Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/httpAdmin.ts src/lib/__tests__/httpAdmin.test.ts
git commit -m "feat: add HTTP admin endpoints for schema fetch and OpenRouter query generation"
```

---

### Task 7: Register Everything in postgrestor.ts + Build Script

**Files:**
- Modify: `postgrestor.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PostgresIntrospectNode` from `src/nodes/PostgresIntrospectNode.ts` (Task 4)
- Consumes: `init` from `src/lib/httpAdmin.ts` (Task 6)
- Produces: Registered node types, active HTTP admin endpoints, updated build script

- [ ] **Step 1: Update postgrestor.ts**

Replace the content of `postgrestor.ts`:

```typescript
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
```

- [ ] **Step 2: Update build script in package.json**

In `package.json`, change the `build` script from:

```json
"build": "tsc && cat src/nodes/PostgresDBNode.html src/nodes/PostgresNode.html src/nodes/PostgresListenerNode.html > dist/postgrestor.html && cp src/nodes/*.html dist/"
```

To:

```json
"build": "tsc && cat src/nodes/PostgresDBNode.html src/nodes/PostgresNode.html src/nodes/PostgresListenerNode.html src/nodes/PostgresIntrospectNode.html > dist/postgrestor.html && cp src/nodes/*.html dist/"
```

- [ ] **Step 3: Run build**

```bash
npm run build
```
Expected: TypeScript compiles, all 4 HTML templates concatenated into `dist/postgrestor.html`.

- [ ] **Step 4: Verify PostgresIntrospectNode appears in built HTML**

```bash
grep -c "PostgresIntrospectNode" dist/postgrestor.html
```
Expected: `3` (template, registration, help).

- [ ] **Step 5: Run full test suite**

```bash
npx jest --no-coverage
```
Expected: all tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add postgrestor.ts package.json
git commit -m "feat: register PostgresIntrospectNode, OpenRouter credential, HTTP admin endpoints"
```

---

### Task 8: PostgresDBNode Editor HTML Upgrades

**Files:**
- Modify: `src/nodes/PostgresDBNode.html`

**Interfaces:**
- Consumes: `GET /postgres-introspect/schema/:configId` HTTP admin endpoint (Task 6)
- Produces: OpenRouter config section (API key, model, prompt style) + schema status badge in the editor UI

- [ ] **Step 1: Add OpenRouter config fields to the editor panel**

In `src/nodes/PostgresDBNode.html`, locate the `<script type="text/x-red" data-template-name="PostgresDBNode">` block. Add before the closing `</div>` of the form (after the `throwErrors` row):

```html
  <div class="form-row">
    <h3 style="margin-bottom: 2px;">🪄 Magic Wand (AI)</h3>
    <span class="postgres-subtitle">Powered by OpenRouter</span>
  </div>
  <div class="form-row">
    <label for="node-input-openrouterApiKey">
      <i class="fa fa-key"></i>
      <span>OpenRouter API Key</span>
    </label>
    <input type="password" id="node-input-openrouterApiKey" placeholder="sk-or-v1-...">
  </div>
  <div class="form-row">
    <label for="node-input-model">
      <i class="fa fa-cube"></i>
      <span>AI Model</span>
    </label>
    <select id="node-input-model">
      <option value="openai/gpt-4o-mini">GPT-4o Mini (fast, cheap)</option>
      <option value="openai/gpt-4o">GPT-4o (smarter)</option>
    </select>
  </div>
  <div class="form-row">
    <label for="node-input-promptStyle">
      <i class="fa fa-sliders"></i>
      <span>AI Prompt Style</span>
    </label>
    <select id="node-input-promptStyle">
      <option value="concise">Concise</option>
      <option value="balanced">Balanced</option>
      <option value="verbose">Verbose (with comments)</option>
    </select>
  </div>
  <div class="form-row" id="postgres-schema-status-row">
    <span id="postgres-schema-status" style="font-size: 0.85em; color: #888;">
      <i class="fa fa-database"></i> Schema: not loaded
    </span>
    <button id="postgres-refresh-schema-btn" class="red-ui-button red-ui-button-small" style="margin-left: 8px;">
      <i class="fa fa-refresh"></i> Refresh Schema
    </button>
  </div>
```

- [ ] **Step 2: Add defaults for the new fields**

In `src/nodes/PostgresDBNode.html`, in the `<script type="text/javascript">` block, locate the `defaults:` object inside `RED.nodes.registerType("PostgresDBNode", ...)`. Add:

```javascript
      model: { value: "openai/gpt-4o-mini" },
      promptStyle: { value: "balanced" },
```

Also add `openrouterApiKey` to the `credentials:` block if there is one in the defaults (check the existing pattern — the PostgresDBNode already uses `credentials` via `postgrestor.ts`, not in the HTML defaults):

```javascript
      credentials: {
        openrouterApiKey: { type: "password" }
      },
```

- [ ] **Step 3: Add schema status refresh logic**

In `src/nodes/PostgresDBNode.html`, in the `oneditsave:` function of the registration block, replace the existing empty `oneditsave` with:

```javascript
    oneditsave: function() {},
    oneditprepare: function() {
      // Schema status badge: fetch cached schema from runtime
      const schemaStatus = $("#postgres-schema-status");
      if (schemaStatus.length && this.id) {
        $.getJSON(`/postgres-introspect/schema/${this.id}`, function(data) {
          if (data.stale) {
            schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded');
          } else {
            const tableCount = Object.keys(data.tables || {}).length;
            const colCount = Object.values(data.tables || {}).reduce(
              function(s, t) { return s + (t.columns || []).length; }, 0
            );
            schemaStatus.html(
              '<i class="fa fa-database"></i> Schema: loaded (' + tableCount + ' tables, ' + colCount + ' columns)'
            );
          }
        }).fail(function() {
          schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded');
        });
      }

      // Refresh Schema button
      $("#postgres-refresh-schema-btn").click(function() {
        schemaStatus.html('<i class="fa fa-spinner fa-spin"></i> Refreshing...');
        // Trigger introspection by sending a message to any PostgresIntrospectNode
        // wired to this config. Simpler: just poll after a delay.
        setTimeout(function() {
          $.getJSON(`/postgres-introspect/schema/${this.id}`, function(data) {
            if (data.stale) {
              schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded — add a PostgresIntrospectNode');
            } else {
              const tableCount = Object.keys(data.tables || {}).length;
              const colCount = Object.values(data.tables || {}).reduce(
                function(s, t) { return s + (t.columns || []).length; }, 0
              );
              schemaStatus.html(
                '<i class="fa fa-database"></i> Schema: loaded (' + tableCount + ' tables, ' + colCount + ' columns)'
              );
            }
          });
        }.bind(this), 2000);
      }.bind(this));
    },
```

Wait — the `this.id` in the setTimeout closure won't work cleanly. Let me use a variable capture pattern instead:

```javascript
    oneditsave: function() {},
    oneditprepare: function() {
      var self = this;
      // Schema status badge: fetch cached schema from runtime
      var schemaStatus = $("#postgres-schema-status");
      if (schemaStatus.length && self.id) {
        $.getJSON("postgres-introspect/schema/" + self.id, function(data) {
          if (data.stale) {
            schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded');
          } else {
            var tableCount = Object.keys(data.tables || {}).length;
            var colCount = 0;
            var tables = data.tables || {};
            for (var k in tables) {
              if (tables.hasOwnProperty(k)) {
                colCount += (tables[k].columns || []).length;
              }
            }
            schemaStatus.html(
              '<i class="fa fa-database"></i> Schema: loaded (' + tableCount + ' tables, ' + colCount + ' columns)'
            );
          }
        }).fail(function() {
          schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded');
        });
      }

      // Refresh Schema button
      $("#postgres-refresh-schema-btn").click(function() {
        schemaStatus.html('<i class="fa fa-spinner fa-spin"></i> Refreshing...');
        var configId = self.id;
        setTimeout(function() {
          $.getJSON("postgres-introspect/schema/" + configId, function(data) {
            if (data.stale) {
              schemaStatus.html('<i class="fa fa-database"></i> Schema: not loaded — add a PostgresIntrospectNode');
            } else {
              var tableCount = Object.keys(data.tables || {}).length;
              var colCount = 0;
              var tables = data.tables || {};
              for (var k in tables) {
                if (tables.hasOwnProperty(k)) {
                  colCount += (tables[k].columns || []).length;
                }
              }
              schemaStatus.html(
                '<i class="fa fa-database"></i> Schema: loaded (' + tableCount + ' tables, ' + colCount + ' columns)'
              );
            }
          });
        }, 2000);
      });
    },
```

Note: make sure `oneditsave` already exists. The current template has `oneditsave: function () { }` — this is fine, we just add `oneditprepare` alongside it.

Looking at the current PostgresDBNode.html registration code more carefully — we need to see its full registration block. Let me note in the instructions that the implementer should check the existing HTML and add the new fields + `oneditprepare` alongside the existing registration code.

Actually, I don't think PostgresDBNode.html currently has a credentials property in its JavaScript registration block (credentials are handled in `postgrestor.ts`). So I should NOT add credentials to the HTML registration — just the model and promptStyle defaults.

- [ ] **Step 4: Rebuild and verify HTML**

```bash
npm run build
grep -c "openrouterApiKey\|postgres-schema-status\|magic-wand" dist/postgrestor.html
```
Expected: references appear.

- [ ] **Step 5: Commit**

```bash
git add src/nodes/PostgresDBNode.html
git commit -m "feat: add OpenRouter config and schema status badge to PostgresDBNode editor"
```

---

### Task 9: PostgresNode Editor HTML Upgrades

**Files:**
- Modify: `src/nodes/PostgresNode.html`

**Interfaces:**
- Consumes: `GET /postgres-introspect/schema/:configId` and `POST /postgres-node/generate-query` HTTP admin endpoints (Task 6)
- Produces: Query autocomplete, table/column picker, generate-query button, inline type hints, magic wand UI

- [ ] **Step 1: Add the Magic Wand markup**

In `src/nodes/PostgresNode.html`, inside the `<script type="text/x-red" data-template-name="PostgresNode">` block, add after the query textarea (before the closing `</div>` of the form):

```html
  <div class="form-row">
    <label style="display: flex; align-items: center; gap: 4px;">
      <span>🪄 Magic Wand</span>
      <span style="font-size: 0.8em; color: #888;">(AI query generator)</span>
    </label>
    <div style="display: flex; gap: 6px;">
      <input type="text" id="postgres-magic-prompt" placeholder="Describe what query you want..."
        style="flex: 1;">
      <button id="postgres-magic-generate" class="red-ui-button">
        <i class="fa fa-magic"></i> Generate
      </button>
    </div>
    <div id="postgres-magic-result" style="display: none; margin-top: 8px; padding: 8px; background: #f0f0f0; border-radius: 4px; font-family: monospace; font-size: 0.9em; white-space: pre-wrap; max-height: 120px; overflow-y: auto;">
    </div>
    <div id="postgres-magic-actions" style="display: none; margin-top: 4px; display: flex; gap: 4px;">
      <button id="postgres-magic-insert" class="red-ui-button red-ui-button-small">
        <i class="fa fa-check"></i> Insert
      </button>
      <button id="postgres-magic-retry" class="red-ui-button red-ui-button-small">
        <i class="fa fa-refresh"></i> Retry
      </button>
      <button id="postgres-magic-cancel" class="red-ui-button red-ui-button-small">
        <i class="fa fa-times"></i> Cancel
      </button>
    </div>
    <div id="postgres-magic-error" style="display: none; margin-top: 4px; color: #c00; font-size: 0.85em;"></div>
  </div>
```

- [ ] **Step 2: Add the Generate Query picker markup**

Add after the magic wand section:

```html
  <div class="form-row">
    <button id="postgres-gen-query-btn" class="red-ui-button" title="Generate a query template from schema">
      <i class="fa fa-bolt"></i> Generate Query Template
    </button>
  </div>
```

- [ ] **Step 3: Add inline type hints markup**

Add after the query textarea (if not already inline):

```html
  <div id="postgres-type-hints" style="font-size: 0.85em; color: #666; margin-top: 2px; min-height: 1.2em;">
  </div>
```

- [ ] **Step 4: Implement the JavaScript for all editor upgrades**

In `src/nodes/PostgresNode.html`, locate the `<script type="text/javascript">` block for PostgresNode registration. In the `oneditprepare` function (or add it if it doesn't exist), add the following logic. 

First, check what `oneditprepare` currently looks like. It likely has `$("#node-input-parseNotifyJson")` selector logic for the existing toggles. We'll add our code after the existing setup.

Replace/extend `oneditprepare` to include:

```javascript
    oneditprepare: function() {
      // --- Existing setup (if any) ---
      // (preserve existing oneditprepare code here)

      // --- Magic Wand ---
      var magicPrompt = $("#postgres-magic-prompt");
      var magicResult = $("#postgres-magic-result");
      var magicActions = $("#postgres-magic-actions");
      var magicError = $("#postgres-magic-error");
      var magicGenerate = $("#postgres-magic-generate");
      var queryEditor = $("#node-input-query");
      var typeHints = $("#postgres-type-hints");
      var genQueryBtn = $("#postgres-gen-query-btn");
      var self = this;

      // Disable magic wand if no schema or no API key
      function checkMagicState() {
        var configId = $("#node-input-PostgresDBNode").val();
        if (!configId) {
          magicGenerate.prop("disabled", true).attr("title", "Select a PostgresDBNode first");
          genQueryBtn.prop("disabled", true).attr("title", "Select a PostgresDBNode first");
          return;
        }
        $.getJSON("postgres-introspect/schema/" + configId, function(data) {
          if (data.stale) {
            magicGenerate.prop("disabled", true).attr("title", "Schema not loaded — add a PostgresIntrospectNode and inject");
            genQueryBtn.prop("disabled", true).attr("title", "Schema not loaded");
          } else {
            self._schemaCache = data;
            magicGenerate.prop("disabled", false).removeAttr("title");
            genQueryBtn.prop("disabled", false).removeAttr("title");
            // Show type hints for current query
            updateTypeHints();
          }
        }).fail(function() {
          magicGenerate.prop("disabled", true).attr("title", "Cannot reach schema endpoint");
          genQueryBtn.prop("disabled", true);
        });
      }

      checkMagicState();

      // Re-check when config changes
      $("#node-input-PostgresDBNode").on("change", checkMagicState);

      // Generate handler
      magicGenerate.click(function() {
        var prompt = magicPrompt.val().trim();
        if (!prompt) return;
        var configId = $("#node-input-PostgresDBNode").val();

        magicGenerate.prop("disabled", true).html('<i class="fa fa-spinner fa-spin"></i> Generating...');
        magicResult.hide();
        magicActions.hide();
        magicError.hide();

        $.ajax({
          url: "postgres-node/generate-query",
          method: "POST",
          contentType: "application/json",
          data: JSON.stringify({ prompt: prompt, configId: configId }),
          success: function(data) {
            magicResult.text(data.query).show();
            magicActions.show();
          },
          error: function(jqXHR) {
            var err = jqXHR.responseJSON?.error || "Unknown error";
            magicError.text("Error: " + err).show();
          },
          complete: function() {
            magicGenerate.prop("disabled", false).html('<i class="fa fa-magic"></i> Generate');
          }
        });
      });

      $("#postgres-magic-insert").click(function() {
        var query = magicResult.text();
        if (query) {
          queryEditor.val(query);
          magicResult.hide();
          magicActions.hide();
          magicError.hide();
          magicPrompt.val("");
          updateTypeHints();
        }
      });

      $("#postgres-magic-retry").click(function() {
        magicGenerate.click();
      });

      $("#postgres-magic-cancel").click(function() {
        magicResult.hide();
        magicActions.hide();
        magicError.hide();
      });

      // --- Generate Query Template ---
      genQueryBtn.click(function() {
        if (!self._schemaCache) return;
        var tables = self._schemaCache.tables || {};
        var tableNames = Object.keys(tables);
        if (tableNames.length === 0) return;

        // Show a simple prompt/picker — for simplicity, pick first table
        // In production, this could be a dropdown; for now, use prompt
        var tableName = prompt("Enter table name (e.g. public.users):", tableNames[0]);
        if (!tableName) return;

        var table = tables[tableName];
        if (!table) { alert("Table not found in schema"); return; }

        var action = prompt("Action: SELECT, INSERT, UPDATE, or DELETE?", "SELECT");
        if (!action) return;

        var cols = table.columns.filter(function(c) { return !c.isGenerated && !c.isIdentity; });
        var colNames = cols.map(function(c) { return c.name; });
        var pk = table.primaryKey;

        var query = "";
        if (action.toUpperCase() === "SELECT") {
          query = "SELECT " + colNames.join(", ") + "\nFROM " + tableName + "\nWHERE ";
          if (pk.length > 0) {
            for (var i = 0; i < pk.length; i++) {
              query += pk[i] + " = $" + (i + 1);
              if (i < pk.length - 1) query += " AND ";
            }
          } else {
            query += "true";
          }
        } else if (action.toUpperCase() === "INSERT") {
          query = "INSERT INTO " + tableName + " (" + colNames.join(", ") + ")\nVALUES (";
          for (var i = 0; i < colNames.length; i++) {
            query += "$" + (i + 1);
            if (i < colNames.length - 1) query += ", ";
          }
          query += ")\nRETURNING *";
        } else if (action.toUpperCase() === "UPDATE") {
          query = "UPDATE " + tableName + " SET ";
          var setParts = [];
          for (var i = 0; i < colNames.length; i++) {
            setParts.push(colNames[i] + " = $" + (i + 1));
          }
          query += setParts.join(", ");
          query += "\nWHERE ";
          if (pk.length > 0) {
            var pkOffset = colNames.length;
            for (var i = 0; i < pk.length; i++) {
              query += pk[i] + " = $" + (pkOffset + i + 1);
              if (i < pk.length - 1) query += " AND ";
            }
          } else {
            query += "true";
          }
        } else if (action.toUpperCase() === "DELETE") {
          query = "DELETE FROM " + tableName + "\nWHERE ";
          if (pk.length > 0) {
            for (var i = 0; i < pk.length; i++) {
              query += pk[i] + " = $" + (i + 1);
              if (i < pk.length - 1) query += " AND ";
            }
          } else {
            query += "true";
          }
        }

        queryEditor.val(query);
        updateTypeHints();
      });

      // --- Inline Type Hints ---
      function updateTypeHints() {
        if (!self._schemaCache) {
          typeHints.text("");
          return;
        }
        var query = queryEditor.val() || "";
        var tables = self._schemaCache.tables || {};
        var fromMatch = query.match(/FROM\s+"?(\w+\.?\w*)"?/i);
        if (fromMatch && fromMatch[1]) {
          var tableKey = fromMatch[1];
          // Try to find the table — check with and without schema prefix
          var table = tables[tableKey];
          if (!table) {
            for (var k in tables) {
              if (tables.hasOwnProperty(k) && (k === tableKey || k.endsWith("." + tableKey))) {
                table = tables[k];
                break;
              }
            }
          }
          if (table && table.columns) {
            var hintText = "→ columns: " + table.columns.map(function(c) {
              var parts = [c.name + "(" + c.type + ")"];
              if (table.primaryKey.indexOf(c.name) >= 0) parts.push("PK");
              if (!c.nullable) parts.push("NOT NULL");
              return parts.join(" ");
            }).join(", ");
            typeHints.text(hintText);
            return;
          }
        }
        typeHints.text("");
      }

      // Update hints on query change
      queryEditor.on("input", updateTypeHints);
    },
```

Note: The existing `oneditprepare` in the PostgresNode HTML is empty (`oneditsave: function () {}` style). We should check the current `oneditprepare`. Actually, looking at the listener HTML pattern, `oneditprepare` is a separate property from `oneditsave`. We add `oneditprepare` if it doesn't exist, or extend it if it does.

- [ ] **Step 5: Rebuild and verify the HTML integrations**

```bash
npm run build
grep -c "postgres-magic\|postgres-gen-query\|postgres-type-hints" dist/postgrestor.html
```
Expected: magic wand, generate query, and type hints references appear.

- [ ] **Step 6: Run full test suite for regressions**

```bash
npx jest --no-coverage
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/nodes/PostgresNode.html
git commit -m "feat: add magic wand, query generator, type hints to PostgresNode editor"
```

---

## Completion Checklist

- [ ] All 9 tasks committed
- [ ] `npx jest --no-coverage` passes (no regressions, all new tests green)
- [ ] `npm run build` produces `dist/postgrestor.html` with all 4 HTML templates
- [ ] `npx tsc --noEmit` produces no errors
- [ ] Each commit message follows conventional commits (`feat:` prefix)
