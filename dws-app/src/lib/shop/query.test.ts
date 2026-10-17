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
  return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('shopQuery', () => {
  it('posts the query with both auth layers and returns rows', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://shop.example.test/query');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer bearer-token');
      expect(headers['CF-Access-Client-Id']).toBe('cf-id');
      expect(headers['CF-Access-Client-Secret']).toBe('cf-secret');
      expect(JSON.parse(String(init?.body))).toEqual({ sql: 'select 1 as ok', params: {}, maxRows: 10 });
      return respond(200, { columns: ['ok'], rows: [{ ok: 1 }], rowCount: 1, truncated: false, durationMs: 3 });
    });
    const rows = await shopQuery<{ ok: number }>('select 1 as ok', {}, { maxRows: 10 }, { fetchImpl, env });
    expect(rows).toEqual([{ ok: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits the Cloudflare headers when the pair is not configured', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      return respond(200, { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 });
    });
    const lanEnv = { SHOP_BRIDGE_URL: 'http://127.0.0.1:8787', SHOP_BRIDGE_TOKEN: 't' } as unknown as NodeJS.ProcessEnv;
    const result = await shopQueryResult('select 1', {}, {}, { fetchImpl, env: lanEnv });
    expect(result.truncated).toBe(false);
  });

  it('fails closed when the bridge is not configured', async () => {
    await expect(shopQuery('select 1', {}, {}, { env: {} as unknown as NodeJS.ProcessEnv })).rejects.toMatchObject({
      name: 'ShopBridgeError',
      status: 503,
      code: 'not_configured',
    });
  });

  it('maps a Cloudflare edge block to edge_blocked', async () => {
    const fetchImpl = vi.fn(async () => respond(403, '<html>forbidden</html>', { 'content-type': 'text/html' }));
    const error = await shopQuery('select 1', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toBeInstanceOf(ShopBridgeError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('edge_blocked');
  });

  it('surfaces the bridge error body', async () => {
    const fetchImpl = vi.fn(async () => respond(400, { error: { code: 'not_read_only', message: 'Only SELECT is allowed' } }));
    const error = await shopQuery('delete from x', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 400, code: 'not_read_only', message: 'Only SELECT is allowed' });
  });

  it('maps a fetch timeout to 504', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'TimeoutError');
    });
    const error = await shopQuery('select 1', {}, { timeoutMs: 5 }, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 504, code: 'timeout' });
  });

  it('maps a network failure to 502', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await shopQuery('select 1', {}, {}, { fetchImpl, env }).catch(e => e);
    expect(error).toMatchObject({ status: 502, code: 'unreachable' });
  });
});

describe('shopHealth', () => {
  it('GETs /health', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://shop.example.test/health');
      expect(init?.method).toBe('GET');
      return respond(200, { ok: true, version: 'Microsoft SQL Server 2016', mirror: { enabled: true } });
    });
    const health = await shopHealth({ fetchImpl, env });
    expect(health.ok).toBe(true);
  });
});
