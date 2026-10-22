import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ShopBridgeError, shopHealth, shopQuery, shopQueryResult } from './query';

const env = {
  SHOP_BRIDGE_URL: 'https://shop.example.test/',
  SHOP_BRIDGE_TOKEN: 'bearer-token',
  CF_ACCESS_CLIENT_ID: 'cf-id',
  CF_ACCESS_CLIENT_SECRET: 'cf-secret',
} as unknown as NodeJS.ProcessEnv;

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('shopQuery', () => {
  it('posts the named query with both auth layers and returns rows', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://shop.example.test/query/project_by_id');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer bearer-token');
      expect(headers['CF-Access-Client-Id']).toBe('cf-id');
      expect(headers['CF-Access-Client-Secret']).toBe('cf-secret');
      expect(JSON.parse(String(init?.body))).toEqual({ params: { id: 3612 }, maxRows: 10 });
      return respond(200, { columns: ['ProjectID'], rows: [{ ProjectID: 3612 }], rowCount: 1, truncated: false, durationMs: 3 });
    });
    const rows = await shopQuery<{ ProjectID: number }>('project_by_id', { id: 3612 }, { maxRows: 10 }, { fetchImpl, env });
    expect(rows).toEqual([{ ProjectID: 3612 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends an empty body when there are no params or row limit', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({});
      return respond(200, { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 });
    });
    await shopQueryResult('open_jobs', undefined, undefined, { fetchImpl, env });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a query name the bridge could not have, without calling it', async () => {
    const fetchImpl = vi.fn();
    for (const name of ['', '1projects', 'projects;drop', 'select * from tblProject', '../health', 'a-b']) {
      const error = await shopQueryResult(name, {}, {}, { fetchImpl, env }).catch(e => e);
      expect(error, name).toBeInstanceOf(ShopBridgeError);
      expect(error, name).toMatchObject({ status: 400, code: 'bad_request' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits the Cloudflare headers when the pair is not configured', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      return respond(200, { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 });
    });
    const lanEnv = { SHOP_BRIDGE_URL: 'http://127.0.0.1:8787', SHOP_BRIDGE_TOKEN: 't' } as unknown as NodeJS.ProcessEnv;
    const result = await shopQueryResult('projects', {}, {}, { fetchImpl, env: lanEnv });
    expect(result.truncated).toBe(false);
  });

  it('fails closed when the bridge is not configured', async () => {
    await expect(shopQuery('projects', {}, {}, { env: {} as unknown as NodeJS.ProcessEnv })).rejects.toMatchObject({
      name: 'ShopBridgeError',
      status: 503,
      code: 'not_configured',
    });
  });

  it('maps a Cloudflare edge block to edge_blocked', async () => {
    const fetchImpl = vi.fn(async () => respond(403, '<html>forbidden</html>', { 'content-type': 'text/html' }));
    const error = await shopQuery('projects', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toBeInstanceOf(ShopBridgeError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('edge_blocked');
  });

  it('surfaces the bridge error body', async () => {
    const fetchImpl = vi.fn(async () => respond(404, { error: { code: 'not_found', message: 'No query named nope' } }));
    const error = await shopQuery('nope', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'No query named nope' });
  });

  it('maps a fetch timeout to 504', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'TimeoutError');
    });
    const error = await shopQuery('projects', {}, { timeoutMs: 5 }, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 504, code: 'timeout' });
  });

  it('maps a body that stalls past the deadline to 504, not a raw error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
    }) as unknown as Response);
    const error = await shopQuery('projects', {}, { timeoutMs: 5 }, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 504, code: 'timeout' });
  });

  it('maps a network failure to 502', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await shopQuery('projects', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 502, code: 'unreachable' });
  });
});

describe('shopHealth', () => {
  it('GETs /health', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://shop.example.test/health');
      expect(init?.method).toBe('GET');
      return respond(200, {
        ok: true,
        version: 'Microsoft SQL Server 2016',
        mirror: { enabled: true },
        queries: { mirror: ['projects', 'contacts'], live: ['project_by_id'] },
      });
    });
    const health = await shopHealth({ fetchImpl, env });
    expect(health.ok).toBe(true);
    expect(health.queries).toEqual({ mirror: ['projects', 'contacts'], live: ['project_by_id'] });
  });
});
