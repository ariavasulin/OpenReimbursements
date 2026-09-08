import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ from: vi.fn(), maybeSingle: vi.fn() }));
vi.mock('@/lib/supabaseAdminClient', () => ({ supabaseAdmin: { from: mocks.from } }));
import { POST, GET, DELETE, OPTIONS } from '@/app/mcp/[shared-key]/route';
import { harnessInstructions } from './harness';

const key = 'a'.repeat(64);
const context = (supplied = key) => ({ params: Promise.resolve({ 'shared-key': supplied }) });
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/mcp/${key}`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.stubEnv('MCP_SHARED_KEY', key);
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) });
  mocks.maybeSingle.mockResolvedValue({ data: { schema_generation: 1, mcp_enabled: true }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('MCP Web Request transport boundary', () => {
  it('rejects wrong keys on all registered methods before any database or SDK work', async () => {
    for (const handler of [GET, POST, DELETE, OPTIONS]) {
      const response = await handler(new Request('http://localhost/mcp/wrong'), context('b'.repeat(64)));
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain(key);
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('fails closed for absent/invalid key configuration and absent/closed release state', async () => {
    for (const configured of ['', 'short', 'A'.repeat(64)]) {
      vi.stubEnv('MCP_SHARED_KEY', configured);
      expect((await GET(new Request('http://localhost/mcp/key'), context())).status).toBe(503);
    }
    vi.stubEnv('MCP_SHARED_KEY', key);
    for (const data of [null, { schema_generation: 1, mcp_enabled: false }, { schema_generation: 2, mcp_enabled: true }]) {
      mocks.maybeSingle.mockResolvedValueOnce({ data, error: null });
      expect((await POST(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), context())).status).toBe(503);
    }
  });
  it('initializes and discovers using distinct per-request SDK instances without session IDs', async () => {
    const initialize = await POST(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'transport-test', version: '1' },
    } }), context());
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    const initialized = (await initialize.json()).result;
    expect(initialized.protocolVersion).toBe('2025-11-25');
    expect(initialized.instructions).toBe(harnessInstructions);
    const discovery = await POST(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' }), context());
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).result.tools.map((tool: {name:string}) => tool.name)).toEqual(['load_dws_skill', 'execute_dws_script']);
    expect(discovery.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects secret-bearing envelope fields and protocol headers without echoing them', async () => {
    for (const request of [
      post({ jsonrpc: '2.0', id: key, method: 'tools/list' }),
      post({ jsonrpc: '2.0', id: 1, method: key }),
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': key }),
      post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_dws_script', arguments: { script_name: 'add_photos', input: { tags: [key] } } } }),
    ]) {
      const response = await POST(request, context());
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(key);
    }
  });
  it('bounds streaming bodies without trusting Content-Length', async () => {
    const response = await POST(post({ oversized: 'x'.repeat(65536) }), context());
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('payload_too_large');
  });
  it('leaves protocol-version and unknown-method errors to the SDK', async () => {
    const response = await POST(post({ jsonrpc: '2.0', id: 9, method: 'arbitrary/eval' }, { 'mcp-protocol-version': '2025-11-25' }), context());
    const error = await response.json();
    expect(error).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32601 } });
    const version = await POST(post({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, { 'mcp-protocol-version': 'unsupported-version' }), context());
    expect(version.status).toBe(400);
    expect((await version.json()).jsonrpc).toBe('2.0');
  });
});
