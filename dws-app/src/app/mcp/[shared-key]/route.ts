import { timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PhotoApiError, readPhotoJson } from '@/lib/photos/server/http';
import { createDwsMcpServer } from '@/lib/mcp/registry';
import { assertNoConfiguredSecrets } from '@/lib/mcp/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ 'shared-key': string }> };
const reject = (status: number, code: string) => Response.json({ error: { code, message: 'DWS request unavailable.' } }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

async function handle(request: Request, context: Context): Promise<Response> {
  try {
    const configured = process.env.MCP_SHARED_KEY;
    const supplied = (await context.params)['shared-key'];
    if (!configured || !/^[0-9a-f]{64}$/.test(configured)) return reject(503, 'temporarily_unavailable');
    if (!/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(configured), Buffer.from(supplied))) return reject(404, 'not_found');
    const { supabaseAdmin } = await import('@/lib/supabaseAdminClient');
    const gate = await supabaseAdmin.from('photo_release_state').select('schema_generation,mcp_enabled').eq('singleton', true).maybeSingle();
    if (gate.error || !gate.data || gate.data.schema_generation !== 1 || gate.data.mcp_enabled !== true) return reject(503, 'temporarily_unavailable');
    // Secret checks precede SDK validation, which may quote invalid values in diagnostics.
    assertNoConfiguredSecrets(Object.fromEntries(request.headers));
    let parsedBody: unknown;
    if (request.method === 'POST') {
      parsedBody = await readPhotoJson(request, 64 * 1024);
      assertNoConfiguredSecrets(parsedBody);
    }
    const server = createDwsMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } finally { await server.close(); }
  } catch (error) {
    if (error instanceof PhotoApiError && error.code === 'payload_too_large') return reject(413, 'payload_too_large');
    return reject(error instanceof PhotoApiError && error.code === 'temporarily_unavailable' ? 503 : 400, 'invalid_input');
  }
}

export { handle as GET, handle as POST, handle as DELETE, handle as PUT, handle as PATCH, handle as OPTIONS, handle as HEAD };
