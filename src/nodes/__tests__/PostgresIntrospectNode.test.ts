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

jest.mock('../../lib/introspect', () => ({
  buildIntrospectionQuery: jest.fn().mockReturnValue('SELECT 1;'),
  assembleSchemaPayload: jest.fn().mockReturnValue({
    database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {}
  }),
}));

jest.mock('../../lib/errorFormatter', () => ({
  formatError: jest.fn().mockReturnValue({ message: 'mock error' }),
}));

import type { SchemaPayload } from '../../lib/types';
import { PostgresIntrospectNode } from '../PostgresIntrospectNode';
import { setRED } from '../../lib/red';

function findInputHandler(ctx: any): Function {
  const handler = ctx.on.mock.calls.find((c: any[]) => c[0] === 'input')?.[1];
  if (!handler) throw new Error('No input handler registered');
  return handler;
}

describe('PostgresIntrospectNode', () => {
  let redRuntime: any;
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
        name: 'introspector', PostgresDBNode: 'config-id-1',
        schema: 'public', cacheTTL: '300', includeSystemCatalogs: 'false',
      };
      const context: any = {
        debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(),
        status: jest.fn(), send: jest.fn(), on: jest.fn(),
      };
      const boundFn = PostgresIntrospectNode.bind(context, config);
      boundFn();
      expect(redRuntime.nodes.createNode).toHaveBeenCalledWith(context, config);
    });
  });

  describe('input handling', () => {
    it('should send cached SchemaPayload when cache is fresh', async () => {
      const cachedPayload: SchemaPayload = {
        database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {},
      };
      mockConfigNode._schemaCache = cachedPayload;
      mockConfigNode._schemaTimestamp = Date.now();

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

      const msg = { payload: 'trigger' };
      findInputHandler(context)(msg);
      await new Promise(r => setTimeout(r, 10));

      expect(context.send).toHaveBeenCalledWith(expect.objectContaining({
        payload: cachedPayload, schema: 'public', database: 'testdb',
      }));
      expect(mockPoolConnect).not.toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'yellow', shape: 'ring' })
      );
    });

    it('should force refresh when msg.refresh is true', async () => {
      mockConfigNode._schemaCache = { database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {} };
      mockConfigNode._schemaTimestamp = Date.now();

      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ server_version: '15.0' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ database: 'testdb' }] });
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

      findInputHandler(context)({ refresh: true });
      await new Promise(r => setTimeout(r, 10));

      expect(mockPoolConnect).toHaveBeenCalled();
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

      findInputHandler(context)({});
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

      const closeHandler = context.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
      expect(closeHandler).toBeDefined();
      closeHandler();
      expect(context.status).toHaveBeenCalledWith({});
    });
  });
});
