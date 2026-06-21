import type { SchemaPayload, TableDef, ColumnDef, ForeignKeyDef, IndexDef, EnumDef } from './types';

export function buildIntrospectionQuery(schema: string, includeSystemCatalogs: boolean): string {
  const schemaFilter = includeSystemCatalogs
    ? `WHERE table_schema IN (${schema.split(',').map(s => `'${s.trim()}'`).join(',')})`
    : `WHERE nc.nspname = '${schema}'`;

  const indexWhereClause = includeSystemCatalogs
    ? `WHERE n.nspname = '${schema}'`
    : `WHERE n.nspname NOT IN ('information_schema', 'pg_catalog') AND n.nspname = '${schema}'`;

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
${indexWhereClause}
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

interface RawRow {
  table_schema?: string;
  table_name?: string;
  column_name?: string;
  data_type?: string;
  is_nullable?: string;
  column_default?: string | null;
  is_identity?: string;
  is_generated?: string;
  character_maximum_length?: number | null;
  udt_name?: string;
  comment?: string | null;
  constraint_type?: string;
  constraint_name?: string;
  foreign_schema?: string;
  foreign_table?: string;
  foreign_column?: string;
  delete_rule?: string;
  update_rule?: string;
  index_name?: string;
  index_columns?: string;
  index_unique?: boolean;
  index_primary?: boolean;
  index_method?: string;
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

  const pkColumns: Record<string, string[]> = {};
  const fkRows: Record<string, ForeignKeyDef[]> = {};
  const indexRows: Record<string, IndexDef[]> = {};

  for (const row of rows) {
    // ---- Columns ----
    if (row.udt_name !== undefined && row.table_name !== undefined) {
      const key = `${row.table_schema}.${row.table_name}`;

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

      // Ensure the FK-owning table has a tables entry
      if (!tables[key]) {
        tables[key] = {
          name: row.table_name || '',
          schema: row.table_schema || '',
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
        };
      }

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

      // Ensure referenced table exists
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

  // Apply PK, FK, indexes
  for (const key of Object.keys(tables)) {
    if (pkColumns[key]) tables[key].primaryKey = pkColumns[key];
    if (fkRows[key]) tables[key].foreignKeys = fkRows[key];
    if (indexRows[key]) tables[key].indexes = indexRows[key];
  }

  return {
    database: 'unknown',
    schema: schemaName,
    version: pgVersion,
    tables,
    enums,
  };
}
