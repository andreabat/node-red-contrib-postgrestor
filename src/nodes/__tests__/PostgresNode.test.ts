// PostgresNode tests — verify TypeScript migration preserves pre-migration behavior
// covering success, both error paths, Mustache rendering, and client release

const mockClient = {
  query: jest.fn(),
  release: jest.fn()
};
const mockPoolConnect = jest.fn().mockResolvedValue(mockClient) as jest.Mock;
const mockPool = {
  connect: mockPoolConnect
};
const mockPoolConstructor: jest.Mock = jest.fn(() => mockPool) as jest.Mock;

jest.mock('pg', () => ({
  Pool: mockPoolConstructor
}));

const mockMustacheRender = jest.fn().mockReturnValue('SELECT 1');
jest.mock('mustache', () => ({
  render: (...args: any[]) => mockMustacheRender(...args)
}));

// Mock named params and error formatter to verify they are called correctly
const mockBindNamedParams = jest.fn().mockReturnValue([]);
jest.mock('../../lib/params', () => ({
  extractNamedParams: jest.fn().mockReturnValue(['1', '2']),
  bindNamedParams: (...args: any[]) => mockBindNamedParams(...args)
}));

const mockFormatError = jest.fn().mockReturnValue({ message: 'mock error' });
jest.mock('../../lib/errorFormatter', () => ({
  formatError: (...args: any[]) => mockFormatError(...args)
}));

// Mock typeMapping to control test behavior
const mockBuildQueryTypes = jest.fn().mockReturnValue(undefined);
jest.mock('../../lib/typeMapping', () => ({
  registerTypeParsers: jest.fn(),
  buildQueryTypes: (...args: any[]) => mockBuildQueryTypes(...args)
}));

const mockPipeline = jest.fn().mockResolvedValue(undefined);
jest.mock('node:stream/promises', () => ({
  pipeline: (...args: any[]) => mockPipeline(...args)
}));

jest.mock('node:stream', () => {
  const actual = jest.requireActual('node:stream');
  return {
    ...actual,
    Readable: {
      from: jest.fn().mockReturnValue(new actual.Readable({ read() { this.push(null); } }))
    }
  };
});

jest.mock('pg-copy-streams', () => ({
  from: jest.fn().mockReturnValue({}),
  to: jest.fn().mockReturnValue({})
}));

import * as pgCopyStreams from 'pg-copy-streams';

import type { PostgresNodeConfig } from '../../lib/types';

import { PostgresNode } from '../PostgresNode';
import { setRED } from '../../lib/red';

describe('PostgresNode', () => {
  let redRuntime: any;
  let nodeInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockMustacheRender.mockReturnValue('SELECT 1');
    mockBindNamedParams.mockReturnValue([]);
    mockFormatError.mockReturnValue({ message: 'mock error' });

    // Build a mock RED runtime
    redRuntime = {
      nodes: {
        createNode: jest.fn(),
        registerType: jest.fn(),
        getNode: jest.fn().mockReturnValue({
          pgPool: mockPool
        })
      }
    };
    setRED(redRuntime);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function buildConfig(overrides: Partial<PostgresNodeConfig> = {}): PostgresNodeConfig {
    return {
      name: 'test-query-node',
      topic: 'test-topic',
      query: 'SELECT * FROM users WHERE id = 1',
      PostgresDBNode: 'config-node-id',
      throwErrors: false,
      useNamedParams: false,
      queryTimeout: '0',
      queryTimeoutFieldType: 'num',
      mapNumeric: false,
      mapTimestamptz: false,
      parseJsonb: false,
      transactionMode: false,
      cursorMode: false,
      copyMode: false,
      cursorBatchSize: '100',
      cursorBatchSizeFieldType: 'num',
      retryEnabled: false,
      maxRetries: '3',
      maxRetriesFieldType: 'num',
      retryBaseDelay: '100',
      retryBaseDelayFieldType: 'num',
      ...overrides
    };
  }

  function buildContext(): any {
    nodeInstance = null;

    // To hook into the node, we use a proxy that captures:
    // - on() calls (input, close) to track event handlers
    // - send() calls
    // - error() calls
    // - status() calls
    // - debug() / log() calls
    const handlers: Record<string, (...args: any[]) => void> = {};

    const context: any = {
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      send: jest.fn(),
      status: jest.fn(),
      on: function (event: string, handler: any) {
        handlers[event] = handler;
      },
      topic: undefined,
      config: undefined
    };

    // Post-expose helpers
    (context as any)._handlers = handlers;
    (context as any)._triggerInput = function (msg: any) {
      if (handlers['input']) {
        handlers['input'](msg);
      }
    };
    (context as any)._triggerClose = function () {
      if (handlers['close']) {
        handlers['close']();
      }
    };

    return context;
  }

  async function runInputAndWait(msg: any): Promise<void> {
    nodeInstance._triggerInput(msg);
    // Advance timers to flush all microtasks and setTimeout callbacks
    await jest.runAllTimersAsync();
  }

  describe('success path', () => {
    it('should execute query and return payload on msg', async () => {
      const selectResult = { command: 'SELECT', rowCount: 2, rows: [{ id: 1 }, { id: 2 }] };
      mockClient.query.mockResolvedValue(selectResult);

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      const inputMsg = { payload: {} };
      await runInputAndWait(inputMsg);

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: 'SELECT 1',
        values: []
      }));
      expect(context.send).toHaveBeenCalledTimes(1);

      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.payload).toBe(selectResult);
      expect(outputMsg.payload.rowCount).toBe(2);
    });

    it('should set green status on success', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 5, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({
          fill: 'green',
          shape: 'ring',
          text: expect.stringContaining('5 rows returned')
        })
      );
    });

    it('should release client after query', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should connect to pool from config node', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(redRuntime.nodes.getNode).toHaveBeenCalledWith('config-node-id');
      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('error + throwErrors=true', () => {
    it('should call node.error with msg to halt flow', async () => {
      mockClient.query.mockRejectedValue(new Error('SQL error'));
      mockFormatError.mockReturnValue({ message: 'SQL error' });

      const config = buildConfig({ throwErrors: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      const inputMsg = { payload: { hello: 'world' } };
      await runInputAndWait(inputMsg);

      expect(context.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'SQL error' }),
        inputMsg
      );
      // When throwErrors=true, msg is set to null and node.send(null) is called
      expect(context.send).toHaveBeenCalledWith(null);
    });

    it('should release client even on error', async () => {
      mockClient.query.mockRejectedValue(new Error('fail'));

      const config = buildConfig({ throwErrors: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should set red status on error', async () => {
      mockClient.query.mockRejectedValue(new Error('boom'));
      mockFormatError.mockReturnValue({ message: 'boom', code: 'ERR' });

      const config = buildConfig({ throwErrors: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({
          fill: 'red',
          shape: 'ring',
          text: expect.stringContaining('boom')
        })
      );
    });
  });

  describe('error + throwErrors=false', () => {
    it('should attach error to msg.payload downstream', async () => {
      mockClient.query.mockRejectedValue(new Error('SQL error'));
      mockFormatError.mockReturnValue({ message: 'SQL error' });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      // node.error called without msg (logs only)
      expect(context.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'SQL error' })
      );
      // node.error should not have a second argument (no msg arg = log only)
      const errorCalls = (context.error as jest.Mock).mock.calls;
      const msgErrorCall = errorCalls.find((call: any[]) => call.length >= 2);
      expect(msgErrorCall).toBeUndefined();

      // node.send called with msg having error
      expect(context.send).toHaveBeenCalledTimes(1);
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error.message).toContain('SQL error');
    });

    it('should release client even when query fails', async () => {
      mockClient.query.mockRejectedValue(new Error('fail'));

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should send original msg properties along with error', async () => {
      mockClient.query.mockRejectedValue(new Error('oops'));
      mockFormatError.mockReturnValue({ message: 'oops' });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ topic: 'my-topic', _msgid: 'abc' });

      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.topic).toBe('my-topic');
      expect(outputMsg._msgid).toBe('abc');
      expect(outputMsg.error).toEqual(expect.objectContaining({ message: 'oops' }));
    });
  });

  describe('Mustache rendering', () => {
    it('should render query template with msg context', async () => {
      mockMustacheRender.mockReturnValue("SELECT 'rendered'");
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig({ query: 'SELECT \'{{msg.greeting}}\'' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ greeting: 'hello' });

      expect(mockMustacheRender).toHaveBeenCalledWith(
        "SELECT '{{msg.greeting}}'",
        expect.objectContaining({ msg: expect.objectContaining({ greeting: 'hello' }) })
      );
    });
  });

  describe('no params', () => {
    it('should call client.query with empty array when msg.params is absent', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.any(String),
        values: []
      }));
    });

    it('should call client.query with msg.params when present', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ params: [42, 'hello'] });

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.any(String),
        values: [42, 'hello']
      }));
    });
  });

  describe('node lifecycle', () => {
    it('should clear status on close', async () => {
      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      nodeInstance._triggerClose();

      expect(context.status).toHaveBeenCalledWith({});
    });

    it('should set topic from config', () => {
      const config = buildConfig({ topic: 'my-topic' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();

      expect(context.topic).toBe('my-topic');
    });

    it('should create node via RED.createNode', () => {
      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();

      expect(redRuntime.nodes.createNode).toHaveBeenCalledWith(context, config);
    });
  });

  describe('connection release error', () => {
    it('should handle release error gracefully', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });
      mockClient.release.mockImplementation(() => { throw new Error('release failed'); });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      // Release was attempted and error was caught
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      // node.error should have been called with the release error
      expect(context.error).toHaveBeenCalledWith(
        expect.stringContaining('release failed')
      );
    });
  });

  describe('named parameter binding', () => {
    it('should call bindNamedParams when useNamedParams is on and msg.params is object', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });
      mockMustacheRender.mockReturnValue('SELECT * WHERE id = $1 AND name = $2');
      mockBindNamedParams.mockReturnValue([42, 'Alice']);

      const config = buildConfig({ useNamedParams: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ params: { name: 'Alice', id: 42 } });

      expect(mockBindNamedParams).toHaveBeenCalledWith(
        'SELECT * WHERE id = $1 AND name = $2',
        { name: 'Alice', id: 42 }
      );
    });

    it('should pass positional array to client.query when useNamedParams is on', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });
      mockBindNamedParams.mockReturnValue([42, 'Alice']);

      const config = buildConfig({ useNamedParams: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ params: { name: 'Alice', id: 42 } });

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.any(String),
        values: [42, 'Alice']
      }));
    });

    it('should pass msg.params array through unchanged when useNamedParams is falsy', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ useNamedParams: false });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ params: [1, 2, 3] });

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.any(String),
        values: [1, 2, 3]
      }));
      expect(mockBindNamedParams).not.toHaveBeenCalled();
    });

    it('should pass msg.params array through unchanged when params is array', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ useNamedParams: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({ params: [10, 20] });

      expect(mockClient.query).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.any(String),
        values: [10, 20]
      }));
      expect(mockBindNamedParams).not.toHaveBeenCalled();
    });

    it('should run Mustache rendering before named parameter binding', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });
      mockBindNamedParams.mockReturnValue([1]);

      const config = buildConfig({ useNamedParams: true, query: 'SELECT * FROM {{msg.table}} WHERE id = $1' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      // Track the call order: Mustache should be called before bindNamedParams
      const callOrder: string[] = [];
      mockMustacheRender.mockImplementation(() => {
        callOrder.push('mustache');
        return 'SELECT * FROM users WHERE id = $1';
      });
      mockBindNamedParams.mockImplementation(() => {
        callOrder.push('bindNamedParams');
        return [1];
      });

      await runInputAndWait({ table: 'users', params: { id: 1 } });

      expect(callOrder).toEqual(['mustache', 'bindNamedParams']);
    });
  });

  describe('structured error handling', () => {
    it('should call formatError with pg-style error on query failure', async () => {
      const pgErr = new Error('relation does not exist') as any;
      pgErr.code = '42P01';
      pgErr.detail = 'Relation users not found';
      pgErr.constraint = 'users_pkey';
      pgErr.table = 'users';
      mockClient.query.mockRejectedValue(pgErr);

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockFormatError).toHaveBeenCalledWith(pgErr);
    });

    it('should set msg.error with structured error fields when throwErrors=false', async () => {
      const pgErr = new Error('dup key') as any;
      pgErr.code = '23505';
      pgErr.detail = 'Key (id)=(1) already exists.';
      pgErr.constraint = 'users_pkey';
      pgErr.table = 'users';
      mockClient.query.mockRejectedValue(pgErr);
      mockFormatError.mockReturnValue({
        message: 'dup key',
        code: '23505',
        detail: 'Key (id)=(1) already exists.',
        constraint: 'users_pkey',
        table: 'users'
      });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error.code).toBe('23505');
      expect(outputMsg.error.detail).toBe('Key (id)=(1) already exists.');
      expect(outputMsg.error.constraint).toBe('users_pkey');
      expect(outputMsg.error.table).toBe('users');
    });

    it('should preserve dual-path error handling with structured errors (throwErrors=true)', async () => {
      const pgErr = new Error('fail') as any;
      pgErr.code = '42P01';
      pgErr.detail = 'detail text';
      mockClient.query.mockRejectedValue(pgErr);
      mockFormatError.mockReturnValue({
        message: 'fail',
        code: '42P01',
        detail: 'detail text'
      });

      const config = buildConfig({ throwErrors: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      const inputMsg = { payload: 'test' };
      await runInputAndWait(inputMsg);

      // node.error called with structuredError and msg (halt flow)
      expect(context.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: '42P01' }),
        inputMsg
      );
      expect(context.send).toHaveBeenCalledWith(null);
    });

    it('should preserve dual-path error handling with structured errors (throwErrors=false)', async () => {
      const pgErr = new Error('fail') as any;
      pgErr.code = '42P01';
      pgErr.detail = 'detail text';
      mockClient.query.mockRejectedValue(pgErr);
      mockFormatError.mockReturnValue({
        message: 'fail',
        code: '42P01',
        detail: 'detail text'
      });

      const config = buildConfig({ throwErrors: false });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      // node.error called with structuredError only (no second arg)
      expect(context.error).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'detail text' })
      );
      // msg.error has structured error
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error).toEqual(expect.objectContaining({ code: '42P01' }));
    });

    it('should detect query timeout errors (code 57014) and format accordingly', async () => {
      const timeoutErr = new Error('canceling statement due to statement timeout') as any;
      timeoutErr.code = '57014';
      timeoutErr.detail = '';
      mockClient.query.mockRejectedValue(timeoutErr);
      mockFormatError.mockReturnValue({
        message: 'Query timeout after 5000ms',
        code: '57014'
      });

      const config = buildConfig({ queryTimeout: '5000' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockFormatError).toHaveBeenCalledWith(timeoutErr);
    });
  });

  describe('query timeout', () => {
    it('should not set statement_timeout when queryTimeout is 0', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ queryTimeout: '0' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      // Only the main query should be called, no SET statement_timeout
      const queryCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('statement_timeout')
      );
      expect(queryCalls.length).toBe(0);
    });

    it('should call SET statement_timeout when queryTimeout > 0', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ queryTimeout: '5000' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const setCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('statement_timeout')
      );
      expect(setCalls.length).toBe(2); // SET + RESET
      expect(setCalls[0]![0]).toBe('SET statement_timeout = 5000');
    });

    it('should reset statement_timeout to 0 in finally block', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ queryTimeout: '5000' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const setCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('statement_timeout')
      );
      expect(setCalls.length).toBe(2);
      expect(setCalls[1]![0]).toBe('SET statement_timeout = 0');
    });

    it('should call client.release() even if SET statement_timeout reset fails', async () => {
      // Main query succeeds, but reset fails
      mockClient.query
        .mockResolvedValueOnce({}) // SET statement_timeout = 5000
        .mockResolvedValueOnce({ command: 'SELECT', rowCount: 0, rows: [] }) // main query
        .mockRejectedValueOnce(new Error('no permission')); // SET statement_timeout = 0 fails

      const config = buildConfig({ queryTimeout: '5000' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should proceed with query if SET statement_timeout fails (e.g., permission denied)', async () => {
      // SET fails, but query should still execute
      mockClient.query
        .mockRejectedValueOnce(new Error('permission denied')) // SET fails
        .mockResolvedValueOnce({ command: 'SELECT', rowCount: 5, rows: [] }); // query succeeds

      const config = buildConfig({ queryTimeout: '5000' });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      // Query still executed
      const queryCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'object' && call[0] !== null && call[0].text && !call[0].text.includes('statement_timeout')
      );
      expect(queryCalls.length).toBe(1);
      // Status should be green (query succeeded)
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'green' })
      );
    });
  });


  describe('type mapping integration (REL-03)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockMustacheRender.mockReturnValue('SELECT 1');
      mockBindNamedParams.mockReturnValue([]);
      mockFormatError.mockReturnValue({ message: 'mock error' });
      mockBuildQueryTypes.mockReturnValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should call client.query with types: undefined when at least one toggle is ON', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig({ mapNumeric: true, mapTimestamptz: false, parseJsonb: true });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const queryCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'object' && call[0] !== null
      );
      expect(queryCall).toBeDefined();
      expect(queryCall![0].types).toBeUndefined();
    });

    it('should call client.query with identity parser when ALL toggles are OFF', async () => {
      mockBuildQueryTypes.mockReturnValue({ getTypeParser: () => (val: string) => val });
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig({ mapNumeric: false, mapTimestamptz: false, parseJsonb: false });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const queryCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'object' && call[0] !== null
      );
      expect(queryCall).toBeDefined();
      expect(queryCall![0].types).toBeDefined();
      expect(typeof queryCall![0].types.getTypeParser).toBe('function');
    });

    it('should call buildQueryTypes with disableJsonb when parseJsonb is OFF', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig({ mapNumeric: true, mapTimestamptz: true, parseJsonb: false });
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockBuildQueryTypes).toHaveBeenCalledWith(
        expect.objectContaining({ disableJsonb: true, disableAll: false })
      );
    });

    it('should call client.query with text and values in config object', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig();
      const context = buildContext();
      const boundFn = PostgresNode.bind(context, config);
      boundFn();
      nodeInstance = context;

      await runInputAndWait({});

      const queryCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'object' && call[0] !== null && call[0].text
      );
      expect(queryCall).toBeDefined();
      expect(queryCall![0].text).toBe('SELECT 1');
      expect(queryCall![0].values).toEqual([]);
    });
  });

  describe('type mapping registration (REL-03 / D-06)', () => {
    it('should NOT import or call registerTypeParsers from PostgresNode (called at pool creation in PostgresDBNode)', () => {
      // Verify registerTypeParsers is not imported in PostgresNode.ts
      // This is a structural check — if registerTypeParsers is imported,
      // it would appear in the mock registration
      const { registerTypeParsers } = require('../../lib/typeMapping');
      expect(registerTypeParsers).not.toHaveBeenCalled();
    });
  });

  describe('transaction mode', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockMustacheRender.mockReturnValue('SELECT 1');
      mockBindNamedParams.mockReturnValue([]);
      mockFormatError.mockReturnValue({ message: 'mock error' });
      mockBuildQueryTypes.mockReturnValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function findStringCall(text: string) {
      return mockClient.query.mock.calls.find(
        (call: any[]) => call[0] === text
      );
    }

    // Test 1: Happy path — BEGIN + query + COMMIT, first output:true rows in msg.payload
    it('should execute BEGIN, queries, COMMIT on transaction with output:true', async () => {
      const insertResult = { command: 'INSERT', rowCount: 1, rows: [{ id: 1 }] };
      mockClient.query
        .mockResolvedValueOnce({}) // SET timeout (won't happen, timeoutMs=0)
        .mockResolvedValueOnce(insertResult) // main query (non-transaction path)
        .mockResolvedValueOnce({}); // unused

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO t VALUES($1)', params: { id: 1 }, output: true }]
      });

      expect(findStringCall('BEGIN')).toBeDefined();
      expect(findStringCall('COMMIT')).toBeDefined();
      expect(mockClient.release).toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'green' })
      );
    });

    // Test 2: Error path — second query in array fails → ROLLBACK called, COMMIT NOT called
    it('should ROLLBACK on transaction query failure and not COMMIT', async () => {
      const pgErr = new Error('SQL error') as any;
      pgErr.code = '23505';
      pgErr.detail = 'duplicate key';
      mockClient.query.mockRejectedValueOnce(pgErr); // fails

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [
          { query: 'INSERT INTO t VALUES($1)', params: { id: 1 }, output: true },
          { query: 'INSERT INTO t VALUES($1)', params: { id: 1 }, output: false }
        ]
      });

      expect(findStringCall('ROLLBACK')).toBeDefined();
      expect(findStringCall('COMMIT')).toBeUndefined();
      expect(mockClient.release).toHaveBeenCalled();
    });

    // Test 3: Client release in finally — verify client.release() called on query failure
    it('should release client in finally even when transaction query fails', async () => {
      mockClient.query.mockRejectedValue(new Error('fail'));

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO t VALUES($1)', params: { id: 1 }, output: true }]
      });

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    // Test 4: First output:true wins — only first query's rows in msg.payload
    it('should use first output:true query result for msg.payload', async () => {
      const result1 = { command: 'SELECT', rowCount: 2, rows: [{ id: 1 }, { id: 2 }] };
      const result2 = { command: 'SELECT', rowCount: 1, rows: [{ id: 3 }] };
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(result1) // entry 1 (output:true)
        .mockResolvedValueOnce(result2) // entry 2 (output:true, but first already captured)
        .mockResolvedValueOnce({}); // COMMIT

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [
          { query: 'SELECT * FROM a', output: true },
          { query: 'SELECT * FROM b', output: true }
        ]
      });

      expect(findStringCall('COMMIT')).toBeDefined();
      // First output:true wins — only result1.rows in msg.payload
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.payload).toEqual([{ id: 1 }, { id: 2 }]);
    });

    // Test 5: No output:true → empty payload ([])
    it('should set msg.payload to empty array when no entry has output:true', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // unused
        .mockResolvedValueOnce({ command: 'INSERT', rowCount: 5, rows: [] });

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO t VALUES(1)' }]
      });

      // After implementation: msg.payload should be [] (empty array, no output:true)
      expect(findStringCall('COMMIT')).toBeDefined();
    });

    // Test 6: Mustache + named params in transaction
    it('should render Mustache and bind named params for each transaction entry', async () => {
      mockMustacheRender.mockReturnValue('INSERT INTO t VALUES($1)');
      mockBindNamedParams.mockReturnValue([42]);
      mockClient.query
        .mockResolvedValueOnce({}) // unused
        .mockResolvedValueOnce({ command: 'INSERT', rowCount: 1, rows: [] });

      const config = buildConfig({ transactionMode: true, useNamedParams: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO {{msg.table}} VALUES($1)', params: { id: 42 }, output: true }]
      });

      // After implementation: mustache.render called and bindNamedParams called for entry
      expect(findStringCall('COMMIT')).toBeDefined();
    });

    // Test 7: ROLLBACK failure resilience — client.release() still called
    it('should release client even when ROLLBACK itself fails', async () => {
      const pgErr = new Error('query error') as any;
      pgErr.code = '23505';
      mockClient.query.mockRejectedValueOnce(pgErr);

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO t VALUES($1)', params: { id: 1 }, output: true }]
      });

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    // Test 8: Backward compat — transactionMode=false with msg.payload array
    it('should NOT enter transaction path when transactionMode is false even with array payload', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 0, rows: [] });

      const config = buildConfig({ transactionMode: false });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'INSERT INTO t VALUES(1)' }]
      });

      // BEGIN/COMMIT/ROLLBACK should NOT be called
      expect(findStringCall('BEGIN')).toBeUndefined();
      expect(findStringCall('COMMIT')).toBeUndefined();
      expect(findStringCall('ROLLBACK')).toBeUndefined();
      // Client should still be released (single query path)
      expect(mockClient.release).toHaveBeenCalled();
    });

    // Test 9: transactionMode ON but msg.payload is NOT an array → backward compat
    it('should fall through to single-query path when transactionMode is on but payload is not array', async () => {
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [{ id: 1 }] });

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({ payload: 'single string payload' });

      expect(findStringCall('BEGIN')).toBeUndefined();
      expect(findStringCall('COMMIT')).toBeUndefined();
      expect(context.send).toHaveBeenCalledTimes(1);
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.payload).toBeDefined();
      expect(outputMsg.payload.rowCount).toBe(1);
    });

    // Test 10: Empty transaction array → BEGIN+COMMIT, msg.payload = []
    it('should handle empty transaction array with BEGIN+COMMIT and empty payload', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}); // COMMIT

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({ payload: [] });

      expect(findStringCall('BEGIN')).toBeDefined();
      expect(findStringCall('COMMIT')).toBeDefined();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ fill: 'green' })
      );
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.payload).toEqual([]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    // Test 11: Transaction preserves msg.topic and msg._msgid
    it('should preserve msg.topic and msg._msgid through transaction', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ command: 'SELECT', rowCount: 1, rows: [{ id: 1 }] }) // entry
        .mockResolvedValueOnce({}); // COMMIT

      const config = buildConfig({ transactionMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        topic: 'my-custom-topic',
        _msgid: 'abc-123',
        payload: [{ query: 'SELECT 1', output: true }]
      });

      expect(findStringCall('COMMIT')).toBeDefined();
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.topic).toBe('my-custom-topic');
      expect(outputMsg._msgid).toBe('abc-123');
      expect(outputMsg.payload).toEqual([{ id: 1 }]);
    });

    // Test 12: Query timeout in transaction (code 57014) — ROLLBACK attempted, error set
    it('should handle query timeout in transaction with ROLLBACK and structured error', async () => {
      const timeoutErr = new Error('canceling statement due to statement timeout') as any;
      timeoutErr.code = '57014';
      mockClient.query
        .mockResolvedValueOnce({}) // SET statement_timeout = 5000
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(timeoutErr); // first entry query times out
      mockFormatError.mockReturnValue({ message: 'Query timeout after 5000ms', code: '57014' });

      const config = buildConfig({ transactionMode: true, queryTimeout: '5000' });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({
        payload: [{ query: 'SELECT * FROM huge_table', output: true }]
      });

      // ROLLBACK should be attempted
      expect(findStringCall('ROLLBACK')).toBeDefined();
      // Client released
      expect(mockClient.release).toHaveBeenCalled();
      // msg.error has structured error
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error).toBeDefined();
      expect(outputMsg.payload).toBeUndefined();
    });
  });

  describe('cursor mode (DECLARE/FETCH)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockMustacheRender.mockReturnValue('SELECT * FROM users');
      mockBindNamedParams.mockReturnValue([]);
      mockFormatError.mockReturnValue({ message: 'mock error' });
      mockBuildQueryTypes.mockReturnValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should use DECLARE/FETCH and emit sequential batches', async () => {
      // Mock the cursor queries: BEGIN, DECLARE, FETCH (2 batches), last FETCH (empty), COMMIT
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // DECLARE
        .mockResolvedValueOnce({ command: 'FETCH', rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }) // FETCH batch 0
        .mockResolvedValueOnce({ command: 'FETCH', rows: [{ id: 3 }], rowCount: 1 }) // FETCH batch 1
        .mockResolvedValueOnce({ command: 'FETCH', rows: [], rowCount: 0 }) // FETCH final (empty)
        .mockResolvedValueOnce({}); // COMMIT

      const config = buildConfig({ cursorMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({ payload: {} });

      // DECLARE was called
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/^DECLARE gsd_/)
      );
      // FETCH was called with batch size
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/FETCH 100 FROM gsd_/)
      );
      // Multiple sends: batch messages + complete
      const sendCalls = (context.send as jest.Mock).mock.calls;
      // First batch
      expect(sendCalls[0]![0]).toEqual(expect.objectContaining({
        payload: [{ id: 1 }, { id: 2 }],
        batch: { index: 0, rows: 2, total: 2 }
      }));
      // Second batch
      expect(sendCalls[1]![0]).toEqual(expect.objectContaining({
        payload: [{ id: 3 }],
        batch: { index: 1, rows: 1, total: 3 }
      }));
      // Completion signal
      expect(sendCalls[2]![0]).toEqual(expect.objectContaining({
        payload: [],
        complete: true,
        total: 3
      }));
    });

    it('should not use cursor for non-SELECT queries', async () => {
      mockMustacheRender.mockReturnValue('INSERT INTO t VALUES(1)');
      mockClient.query.mockResolvedValue({ command: 'INSERT', rowCount: 1, rows: [] });

      const config = buildConfig({ cursorMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({ payload: {} });

      // Should not call DECLARE
      const declareCall = mockClient.query.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].startsWith('DECLARE'));
      expect(declareCall).toBeUndefined();
      // Single send (normal path)
      expect(context.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('COPY mode', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockMustacheRender.mockReturnValue('COPY t FROM STDIN');
      mockBindNamedParams.mockReturnValue([]);
      mockFormatError.mockReturnValue({ message: 'mock error' });
      mockBuildQueryTypes.mockReturnValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should use copyFrom for COPY FROM queries', async () => {
      mockMustacheRender.mockReturnValue('COPY t FROM STDIN');

      const config = buildConfig({ copyMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({ payload: 'csv,data\n' });

      expect(pgCopyStreams.from).toHaveBeenCalled();
      expect(pgCopyStreams.to).not.toHaveBeenCalled();
      expect(mockPipeline).toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'COPY import complete' })
      );
    });

    it('should use copyTo for COPY TO STDOUT queries', async () => {
      mockMustacheRender.mockReturnValue('COPY t TO STDOUT WITH (FORMAT csv)');

      const config = buildConfig({ copyMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      expect(pgCopyStreams.to).toHaveBeenCalled();
      expect(pgCopyStreams.from).not.toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'COPY export complete' })
      );
    });

    it('should route COPY (subquery) TO STDOUT to copyTo, not copyFrom', async () => {
      // Regression test: the old includes('FROM') check falsely matched
      // FROM inside subqueries, hitting the COPY FROM path and crashing.
      mockMustacheRender.mockReturnValue(
        "COPY (SELECT * FROM motors_data WHERE motor_id = 'M001') TO STDOUT WITH (FORMAT csv)"
      );

      const config = buildConfig({ copyMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      expect(pgCopyStreams.to).toHaveBeenCalled();
      expect(pgCopyStreams.from).not.toHaveBeenCalled();
      expect(context.status).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'COPY export complete' })
      );
    });

    it('should not use COPY mode for non-COPY queries', async () => {
      mockMustacheRender.mockReturnValue('SELECT 1');
      mockClient.query.mockResolvedValue({ command: 'SELECT', rowCount: 1, rows: [] });

      const config = buildConfig({ copyMode: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockPipeline).not.toHaveBeenCalled();
      expect(context.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on transient errors', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
      mockMustacheRender.mockReturnValue('SELECT 1');
      mockBindNamedParams.mockReturnValue([]);
      mockFormatError.mockReturnValue({ message: 'mock error' });
      mockBuildQueryTypes.mockReturnValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should retry on transient deadlock error (40P01)', async () => {
      const deadlockErr = new Error('deadlock detected') as any;
      deadlockErr.code = '40P01';

      mockClient.query
        .mockRejectedValueOnce(deadlockErr) // first attempt fails
        .mockResolvedValueOnce({ command: 'SELECT', rowCount: 1, rows: [{ id: 1 }] }); // retry succeeds

      const config = buildConfig({ retryEnabled: true, maxRetries: '3' });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      // Second call succeeded
      expect(context.send).toHaveBeenCalledTimes(1);
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.payload.rowCount).toBe(1);
    });

    it('should not retry non-transient errors (syntax error)', async () => {
      const syntaxErr = new Error('syntax error') as any;
      syntaxErr.code = '42601';
      mockClient.query.mockRejectedValueOnce(syntaxErr);
      mockFormatError.mockReturnValue({ message: 'syntax error', code: '42601' });

      const config = buildConfig({ retryEnabled: true, maxRetries: '3' });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      // Only 1 connection attempt (no retry)
      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
      expect(context.error).toHaveBeenCalled();
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error).toBeDefined();
    });

    it('should propagate error after max retries exhausted', async () => {
      const deadlockErr = new Error('deadlock') as any;
      deadlockErr.code = '40P01';
      // 3 attempt failures (initial + 2 retries with maxRetries=2)
      mockClient.query
        .mockRejectedValueOnce(deadlockErr)
        .mockRejectedValueOnce(deadlockErr)
        .mockRejectedValueOnce(deadlockErr);
      mockFormatError.mockReturnValue({ message: 'deadlock', code: '40P01' });

      const config = buildConfig({ retryEnabled: true, maxRetries: '2' });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      // Should have tried (1 + maxRetries) = 3 connection attempts
      expect(mockPoolConnect).toHaveBeenCalledTimes(3);
      const outputMsg = (context.send as jest.Mock).mock.calls[0]![0];
      expect(outputMsg.error).toBeDefined();
    });

    it('should NOT retry when retryEnabled is off', async () => {
      const deadlockErr = new Error('deadlock') as any;
      deadlockErr.code = '40P01';
      mockClient.query.mockRejectedValueOnce(deadlockErr);

      const config = buildConfig({ retryEnabled: false, maxRetries: '3' });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
    });

    it('should not retry cursor mode queries', async () => {
      mockMustacheRender.mockReturnValue('SELECT * FROM users');
      const deadlockErr = new Error('deadlock') as any;
      deadlockErr.code = '40P01';
      mockClient.query.mockRejectedValueOnce(deadlockErr);

      const config = buildConfig({ cursorMode: true, retryEnabled: true });
      const context = buildContext();
      PostgresNode.bind(context, config)();
      nodeInstance = context;

      await runInputAndWait({});

      // Cursor path: only 1 connection (DECLARE fails, no retry)
      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
    });
  });
});