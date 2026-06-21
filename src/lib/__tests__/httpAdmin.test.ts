import { init } from '../httpAdmin';

// Mock fetch
const mockFetch = jest.fn();

// Mock getSchemaCache — httpAdmin imports it from ./schemaCache
const mockSchemaMap = new Map<string, any>();
jest.mock('../schemaCache', () => ({
  getSchemaCache: jest.fn(() => mockSchemaMap),
}));

jest.mock('../introspect', () => ({
  buildIntrospectionQueries: jest.fn().mockReturnValue(['SELECT 1']),
  assembleSchemaPayload: jest.fn().mockReturnValue({
    database: 'testdb', schema: 'public', version: 150006, tables: { 'public.t': { name: 't', schema: 'public', columns: [{ name: 'c', type: 'int4', nullable: false, isIdentity: false, isGenerated: false }], primaryKey: ['c'], foreignKeys: [], indexes: [] } }, enums: {}
  }),
}));

jest.mock('../errorFormatter', () => ({
  formatError: jest.fn().mockReturnValue({ message: 'mock error' }),
}));

describe('httpAdmin', () => {
  let routes: Record<string, { method: string; handler: Function }> = {};
  let mockRED: any;

  beforeEach(() => {
    jest.clearAllMocks();
    routes = {};
    mockSchemaMap.clear();
    (globalThis as any).fetch = mockFetch;
    mockRED = {
      httpAdmin: {
        get: jest.fn((path: string, handler: Function) => {
          routes['GET ' + path] = { method: 'GET', handler };
        }),
        post: jest.fn((path: string, handler: Function) => {
          routes['POST ' + path] = { method: 'POST', handler };
        }),
      },
      nodes: { getNode: jest.fn() },
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    };
    init(mockRED);
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  describe('GET /postgres-introspect/schema/:configId', () => {
    it('should register the endpoint', () => {
      expect(mockRED.httpAdmin.get).toHaveBeenCalledWith(
        '/postgres-introspect/schema/:configId', expect.any(Function)
      );
    });

    it('should return { stale: true } when node not found', async () => {
      mockRED.nodes.getNode.mockReturnValue(null);
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
      await handler({ params: { configId: 'nonexistent' } }, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith({ stale: true });
    });

    it('should return cached payload when available', async () => {
      const cached = { database: 'testdb', schema: 'public', version: 150006, tables: {}, enums: {} };
      mockSchemaMap.set('config-1', { payload: cached, timestamp: Date.now() });
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
      await handler({ params: { configId: 'config-1' } }, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith(cached);
    });
  });

  describe('POST /postgres-introspect/refresh/:configId', () => {
    it('should register the endpoint', () => {
      const refreshCall = mockRED.httpAdmin.post.mock.calls.find(
        (c: any[]) => c[0] === '/postgres-introspect/refresh/:configId'
      );
      expect(refreshCall).toBeDefined();
    });

    it('should run introspection and cache the result', async () => {
      const mockQuery = jest.fn()
        .mockResolvedValueOnce({ rows: [{ server_version: '15.0' }] })   // version
        .mockResolvedValueOnce({ rows: [] })                               // columns query
        .mockResolvedValueOnce({ rows: [{ database: 'testdb' }] });        // current_database
      const mockClient = { query: mockQuery, release: jest.fn() };
      const mockConfigNode = { pgPool: { connect: jest.fn().mockResolvedValue(mockClient) } };
      mockRED.nodes.getNode.mockReturnValue(mockConfigNode);

      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-introspect/refresh/:configId']?.handler;
      await handler({ params: { configId: 'c1' } }, mockRes);

      expect(mockConfigNode.pgPool.connect).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.any(Object),
        tableCount: expect.any(Number),
        colCount: expect.any(Number),
      }));
      // Cache should be populated
      expect(mockSchemaMap.has('c1')).toBe(true);
    });

    it('should return 404 when config node not found', async () => {
      mockRED.nodes.getNode.mockReturnValue(null);
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-introspect/refresh/:configId']?.handler;
      await handler({ params: { configId: 'nonexistent' } }, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 500 on connection error', async () => {
      const mockConfigNode = {
        pgPool: { connect: jest.fn().mockRejectedValue(new Error('Connection refused')) }
      };
      mockRED.nodes.getNode.mockReturnValue(mockConfigNode);
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-introspect/refresh/:configId']?.handler;
      await handler({ params: { configId: 'c1' } }, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /postgres-node/generate-query', () => {
    it('should return 400 when no API key', async () => {
      mockRED.nodes.getNode.mockReturnValue({ _schemaCache: {}, credentials: {} });
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-node/generate-query']?.handler;
      await handler({ body: { prompt: 'test', configId: 'c1' } }, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when no schema cached', async () => {
      mockRED.nodes.getNode.mockReturnValue({ _schemaCache: null, credentials: { openrouterApiKey: 'sk-test' } });
      // Schema cache map is empty, so endpoint should return 400
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-node/generate-query']?.handler;
      await handler({ body: { prompt: 'test', configId: 'c1' } }, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should call OpenRouter and return SQL', async () => {
      const schema = { database: 'x', schema: 'public', version: 150000, tables: {}, enums: {} };
      mockSchemaMap.set('c1', { payload: schema, timestamp: Date.now() });
      mockRED.nodes.getNode.mockReturnValue({
        _schemaCache: schema,
        credentials: { openrouterApiKey: 'sk-test' },
        openrouterApiKey: 'sk-test',
        model: 'openai/gpt-4o-mini',
        promptStyle: 'balanced',
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'SELECT 1;' } }] }),
      });
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-node/generate-query']?.handler;
      await handler({ body: { prompt: 'select all', configId: 'c1' } }, mockRes);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      );
      expect(mockRes.json).toHaveBeenCalledWith({ query: 'SELECT 1;' });
    });

    it('should strip markdown fences', async () => {
      const schema = { database: 'x', schema: 'public', version: 150000, tables: {}, enums: {} };
      mockSchemaMap.set('c1', { payload: schema, timestamp: Date.now() });
      mockRED.nodes.getNode.mockReturnValue({
        _schemaCache: schema,
        credentials: { openrouterApiKey: 'sk-test' },
        openrouterApiKey: 'sk-test',
        model: 'openai/gpt-4o-mini',
        promptStyle: 'balanced',
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ choices: [{ message: { content: '```sql\nSELECT 1;\n```' } }] }),
      });
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-node/generate-query']?.handler;
      await handler({ body: { prompt: 'test', configId: 'c1' } }, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith({ query: 'SELECT 1;' });
    });
  });
});
