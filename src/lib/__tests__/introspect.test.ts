import { buildIntrospectionQueries, assembleSchemaPayload } from '../introspect';

describe('buildIntrospectionQueries', () => {
  it('should return 5 queries for a single schema', () => {
    const queries = buildIntrospectionQueries('public', false);
    expect(queries).toHaveLength(5);
    expect(queries[0]).toContain('information_schema.columns');
    expect(queries[1]).toContain('PRIMARY KEY');
    expect(queries[2]).toContain('FOREIGN KEY');
    expect(queries[3]).toContain('pg_index');
    expect(queries[4]).toContain('pg_enum');
  });

  it('should target a specific schema in the columns query', () => {
    const queries = buildIntrospectionQueries('public', false);
    expect(queries[0]).toContain("WHERE nc.nspname = 'public'");
  });

  it('should exclude system catalogs in index query when includeSystemCatalogs is false', () => {
    const queries = buildIntrospectionQueries('public', false);
    expect(queries[3]).toContain("WHERE n.nspname NOT IN ('information_schema', 'pg_catalog')");
  });

  it('should not filter system catalogs when includeSystemCatalogs is true', () => {
    const queries = buildIntrospectionQueries('public', true);
    expect(queries[3]).toContain("WHERE n.nspname = 'public'");
    expect(queries[3]).not.toContain("NOT IN");
  });

  it('should include pg_description in columns query for comments', () => {
    const queries = buildIntrospectionQueries('public', false);
    expect(queries[0]).toContain('pg_description');
  });
});

describe('assembleSchemaPayload', () => {
  it('should build a SchemaPayload from raw query rows', () => {
    const rows = [
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
      { table_schema: 'public', table_name: 'users', column_name: 'id',
        constraint_type: 'PRIMARY KEY', constraint_name: 'users_pkey' },
      { table_schema: 'public', table_name: 'orders', column_name: 'user_id',
        constraint_name: 'orders_user_id_fkey', constraint_type: 'FOREIGN KEY',
        foreign_schema: 'public', foreign_table: 'users', foreign_column: 'id',
        delete_rule: 'CASCADE', update_rule: 'NO ACTION' },
      { table_schema: 'public', table_name: 'users', index_name: 'users_pkey',
        index_columns: 'id', index_unique: true, index_primary: true,
        index_method: 'btree' },
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'pending' },
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'active' },
      { enum_schema: 'public', enum_name: 'user_status', enum_value: 'banned' },
    ];

    const result = assembleSchemaPayload(rows, 'public', 150006);

    expect(result.database).toBe('unknown');
    expect(result.schema).toBe('public');
    expect(result.version).toBe(150006);

    const users = result.tables['public.users'];
    expect(users).toBeDefined();
    expect(users.name).toBe('users');
    expect(users.columns).toHaveLength(3);
    expect(users.primaryKey).toEqual(['id']);
    expect(users.foreignKeys).toHaveLength(0);
    expect(users.indexes).toHaveLength(1);

    const idCol = users.columns.find(c => c.name === 'id')!;
    expect(idCol.type).toBe('int4');
    expect(idCol.nullable).toBe(false);
    expect(idCol.isIdentity).toBe(false);
    expect(idCol.comment).toBe('Primary key');

    const statusCol = users.columns.find(c => c.name === 'status')!;
    expect(statusCol.type).toBe('user_status');
    expect(statusCol.enumName).toBe('user_status');
    expect(statusCol.nullable).toBe(true);

    expect(result.tables['public.orders']).toBeDefined();
    expect(result.enums['public.user_status'].values).toEqual(['pending', 'active', 'banned']);
  });

  it('should return empty tables/enums for empty rows', () => {
    const result = assembleSchemaPayload([], 'public', 140000);
    expect(result.tables).toEqual({});
    expect(result.enums).toEqual({});
  });
});
