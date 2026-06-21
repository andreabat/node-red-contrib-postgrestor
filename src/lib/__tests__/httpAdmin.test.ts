import { init } from '../httpAdmin';

// Mock global fetch
const mockFetch = jest.fn();

describe('httpAdmin', () => {
  let routes: Record<string, { method: string; handler: Function }> = {};
  let mockRED: any;

  beforeEach(() => {
    jest.clearAllMocks();
    routes = {};
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
      mockRED.nodes.getNode.mockReturnValue({ _schemaCache: cached, _schemaTimestamp: Date.now() });
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['GET /postgres-introspect/schema/:configId']?.handler;
      await handler({ params: { configId: 'config-1' } }, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith(cached);
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
      const mockRes = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const handler = routes['POST /postgres-node/generate-query']?.handler;
      await handler({ body: { prompt: 'test', configId: 'c1' } }, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should call OpenRouter and return SQL', async () => {
      mockRED.nodes.getNode.mockReturnValue({
        _schemaCache: { database: 'x', schema: 'public', version: 150000, tables: {}, enums: {} },
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
      mockRED.nodes.getNode.mockReturnValue({
        _schemaCache: { database: 'x', schema: 'public', version: 150000, tables: {}, enums: {} },
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
