import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFixtures } from '../fixtures';
import type { IssueSubmissionResult } from '../../src/lib/mcp/issues';

const origin = process.env.DWS_MCP_BASE_URL;
const key = process.env.MCP_SHARED_KEY;
const control = process.env.DWS_TEST_HTTP_CONTROL_URL;
if (!origin || !key || !control) throw new Error('Use npm run test:routes with its actual local Next/GitHub harness');
const endpoint = new URL(`/mcp/${key}`, origin);
const evidence: Record<string, unknown> = { fixture: 'local Next + disposable PostgreSQL 15 + local GitHub HTTP mock', scenarios: [] };
const scenarios = evidence.scenarios as unknown[];
type MockState = { issues: Array<{ number: number; title: string; body: string; labels: string[] }>; requests: Array<{ method: string; path: string; authorized: boolean; body?: { title: string; body: string; labels: string[] } }> };
let f: Awaited<ReturnType<typeof createFixtures>>;
let client: Client;
let transport: StreamableHTTPClientTransport;

async function mockControl(body: Record<string, unknown>) {
  const result = await fetch(`${control}/__fixture/control`, { method: 'POST', body: JSON.stringify(body) });
  expect(result.status).toBe(200);
}
async function mockState(): Promise<MockState> { return (await fetch(`${control}/__fixture/state`)).json(); }
function decode<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  expect(result.isError).not.toBe(true);
  const block = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
  expect(block?.text).toBeTruthy();
  expect(block!.text).not.toContain(key);
  expect(block!.text).not.toContain(process.env.DWS_GITHUB_ISSUES_TOKEN);
  return JSON.parse(block!.text!) as T;
}
async function script<T>(name: string, input: Record<string, unknown>) {
  return decode<T>(await client.callTool({ name: 'execute_dws_script', arguments: { script_name: name, input } }));
}
const report = (suffix: string) => ({ title: `Fixture report ${suffix}`, body: 'The selected photo does not appear.\n\nExpected: the photo appears after upload.', kind: 'bug', reporter_name: 'Fixture Employee', anonymous: false, confirmed: true });

beforeAll(async () => {
  f = await createFixtures();
  // Authority scenarios may remove the singleton; this suite owns its gate setup.
  await f.sql.query(`insert into public.photo_release_state(singleton,schema_generation,mcp_enabled,photo_writes_enabled)
    values(true,1,true,true) on conflict(singleton) do update
    set schema_generation=1,mcp_enabled=true,photo_writes_enabled=true`);
  client = new Client({ name: 'dws-isolated-sdk-verifier', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(endpoint);
  await client.connect(transport);
}, 120_000);
afterAll(async () => {
  await client?.close();
  await f?.close();
  const artifact = JSON.stringify(evidence, null, 2);
  for (const secret of [key, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.DWS_GITHUB_ISSUES_TOKEN]) {
    if (secret && artifact.includes(secret)) throw new Error('Refusing to save secret-bearing protocol evidence');
  }
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(resolve(evidence.protocol_version ? 'test-results/phase6-mcp-http.json' : 'test-results/phase6-mcp-http-focused.json'), artifact + '\n');
});

describe('official SDK against the actual HTTP MCP endpoint (AC-1, AC-2)', () => {
  it('negotiates protocol, discovers exactly two tools, and loads both complete skills', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['execute_dws_script', 'load_dws_skill']);
    expect(transport.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(transport.sessionId).toBeUndefined();
    const skills = [];
    for (const skill_name of ['photos', 'report_issue']) {
      const skill = decode<{ skill_name: string; instructions: string; scripts: Array<{ script_name: string; input_schema: unknown }> }>(await client.callTool({ name: 'load_dws_skill', arguments: { skill_name } }));
      expect(skill.skill_name).toBe(skill_name);
      expect(skill.instructions).toEqual(expect.any(String));
      expect(skill.instructions.trim()).not.toBe('');
      expect(skill.scripts).toHaveLength(skill_name === 'photos' ? 5 : 1);
      expect(skill.scripts.every(item => item.input_schema && item.script_name)).toBe(true);
      skills.push({ skill_name, scripts: skill.scripts.map(item => item.script_name) });
    }
    Object.assign(evidence, { protocol_version: transport.protocolVersion, tools: tools.tools.map(tool => tool.name), session_id: null, skills });
    scenarios.push({ name: 'sdk-discovery-and-both-skill-loads', passed: true });
  });

  it('continues on the same SDK transport after a fresh Next process replaces every handler', async () => {
    const restarted = await fetch(`${control}/__fixture/restart-next`, { method: 'POST' });
    expect(restarted.status).toBe(200);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(2);
    const skill = decode<{ skill_name: string }>(await client.callTool({ name: 'load_dws_skill', arguments: { skill_name: 'photos' } }));
    expect(skill.skill_name).toBe('photos');
    expect(transport.sessionId).toBeUndefined();
    scenarios.push({ name: 'same-client-survives-server-process-restart', passed: true });
  }, 120_000);

  it('creates all five real digest-only handoffs without looking up private photos', async () => {
    const selector = { photos: [{ photo_id: randomUUID() }] };
    const inputs = { migrate_photos: { sources: [{ label: 'Office folder', job_number: '3612' }] }, add_photos: { job_number: '3612' }, move_photos: { selector, destination_job_number: '4170' }, remove_photos: { selector }, restore_photos: { selector, destination_job_number: '4170' } };
    const handoffs = [];
    for (const [name, input] of Object.entries(inputs)) {
      const value = await script<{ handoff_url: string; expires_at: string }>(name, input);
      expect(Object.keys(value).sort()).toEqual(['expires_at', 'handoff_url']);
      const url = new URL(value.handoff_url);
      expect(url.origin).toBe(origin);
      expect(url.searchParams.get('script_name')).toBe(name);
      const token = url.searchParams.get('token')!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value.handoff_url).not.toContain(key);
      const digest = createHash('sha256').update(token).digest('hex');
      const { rows } = await f.sql.query('select script_name,requested_input,consumed_at from public.dws_action_handoffs where token_digest=$1', [digest]);
      expect(rows).toEqual([{ script_name: name, requested_input: input, consumed_at: null }]);
      handoffs.push({ script_name: name, path: url.pathname, expires_at: value.expires_at, token_digest_stored: true });
    }
    evidence.handoffs = handoffs;
    scenarios.push({ name: 'five-script-http-handoffs', passed: true });
  });

  it('rejects wrong/missing keys, closed gates, unknown registries, and secret echoes', async () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: transport.protocolVersion, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
    const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    const dispatch = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'load_dws_skill', arguments: { skill_name: 'photos' } } };
    for (const path of [`/mcp/${'f'.repeat(64)}`, '/mcp']) {
      for (const body of [initialize, dispatch]) {
        const result = await post(new URL(path, origin).href, body);
        expect(result.status).toBe(404);
        expect(await result.text()).not.toContain('Use migrate_photos');
      }
    }
    const savedGate = (await f.sql.query('select * from public.photo_release_state')).rows[0];
    for (const state of ['closed', 'absent']) {
      if (state === 'closed') await f.sql.query('update public.photo_release_state set mcp_enabled=false');
      else await f.sql.query('delete from public.photo_release_state');
      try {
        for (const body of [initialize, dispatch]) {
          const result = await post(endpoint.href, body);
          expect(result.status).toBe(503);
          expect(result.headers.get('cache-control')).toBe('no-store');
          expect(await result.text()).not.toContain(key);
        }
      } finally {
        await f.sql.query('delete from public.photo_release_state');
        await f.sql.query('insert into public.photo_release_state select * from json_populate_record(null::public.photo_release_state,$1::json)', [JSON.stringify(savedGate)]);
      }
    }
    for (const script_name of ['eval', 'constructor', 'run_shell']) {
      const result = await client.callTool({ name: 'execute_dws_script', arguments: { script_name, input: {} } });
      expect(result.isError).toBe(true);
    }
    const before = Number((await f.sql.query('select count(*) from public.dws_action_handoffs')).rows[0].count);
    const secretVariants = [
      { script_name: 'add_photos', input: { job_number: key } },
      { script_name: 'migrate_photos', input: { sources: [{ label: key }] } },
      { script_name: 'add_photos', input: { tags: [key] } },
      { script_name: 'remove_photos', input: { selector: { photos: [{ photo_url: `${origin}/photos/${randomUUID()}?photo=${randomUUID()}&hint=${key}` }] } } },
      { script_name: 'add_photos', input: { hints: { connector: key } } },
    ];
    for (const args of secretVariants) {
      const secretInput = await post(endpoint.href, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'execute_dws_script', arguments: args } });
      expect(secretInput.status).toBe(400);
      expect(await secretInput.text()).not.toContain(key);
    }
    expect(Number((await f.sql.query('select count(*) from public.dws_action_handoffs')).rows[0].count)).toBe(before);
    scenarios.push({ name: 'keys-gate-registry-and-secret-rejection', passed: true });
  });
});

describe('confirmed issue publication through HTTP and the local GitHub mock (AC-12, AC-13)', () => {
  it('publishes contextual paths and colon labels as exact confirmed text without a browser session', async () => {
    await mockControl({ reset: true });
    const input = { ...report(randomUUID()), title: 'File: import failed',
      body: 'Files under J:\\Photos\\3612 fail to import.\nData: 3 files\nThe dws-submission: identifier appeared in the error.', idempotency_key: randomUUID() };
    const result = await script<IssueSubmissionResult>('create_github_issue', input);
    expect(result.status).toBe('published');
    expect(result.issue_url).toBe('https://github.com/ariavasulin/OpenReimbursements/issues/9000');
    const state = await mockState();
    expect(state.requests.filter(request => request.method === 'POST')).toEqual([{ method: 'POST', path: '/repos/ariavasulin/OpenReimbursements/issues', authorized: true, body: { title: input.title, body: `${input.body}\n\nReported by: Fixture Employee\n\n<!-- dws-submission:${result.submission_id} -->`, labels: ['source:dws-mcp', 'bug'] } }]);
    evidence.confirmed_publication = { result, github_request: state.requests[0].body, browser_session_required: false };
    scenarios.push({ name: 'confirmed-exact-publication-with-attribution', passed: true });
  });

  it('serializes concurrent identical payloads under different keys and rejects changed key reuse', async () => {
    await mockControl({ reset: true });
    const input = { ...report(randomUUID()), anonymous: true, reporter_name: undefined };
    const firstKey = randomUUID();
    const results = await Promise.all([script<IssueSubmissionResult>('create_github_issue', { ...input, idempotency_key: firstKey }), script<IssueSubmissionResult>('create_github_issue', { ...input, idempotency_key: randomUUID() })]);
    expect(new Set(results.map(value => value.submission_id)).size).toBe(1);
    expect((await mockState()).requests.filter(request => request.method === 'POST')).toHaveLength(1);
    const final = await script<IssueSubmissionResult>('create_github_issue', { ...input, idempotency_key: firstKey });
    expect(final.status).toBe('published');
    const collision = await client.callTool({ name: 'execute_dws_script', arguments: { script_name: 'create_github_issue', input: { ...input, title: 'Changed confirmed title', idempotency_key: firstKey } } });
    expect(collision.isError).toBe(true);
    const state = await mockState();
    expect(state.issues[0].body).toBe(`${input.body}\n\n<!-- dws-submission:${final.submission_id} -->`);
    evidence.concurrent_publication = { results, final, post_count: 1, anonymous_body: state.issues[0].body };
    scenarios.push({ name: 'concurrent-digest-serialization-and-client-key-conflict', passed: true });
  });

  it('renews a delayed definitive retry so concurrent fresh keys reuse its successful issue', async () => {
    await mockControl({ reset: true, mode: 'reject' });
    const input = { ...report(randomUUID()), idempotency_key: randomUUID() };
    const failed = await script<IssueSubmissionResult>('create_github_issue', input);
    expect(failed.status).toBe('failed');
    expect(failed.issue_url).toBeUndefined();
    expect(failed.error).toMatchObject({ code: 'github_rejected', retryable: true });
    expect(failed.error?.message).toContain('fixed repository');
    expect(failed.error?.message).not.toContain('Fixture permission remedy required');
    expect((await mockState()).issues).toHaveLength(0);
    await f.sql.query("update public.issue_report_submissions set created_at=now()-interval '2 days',dedupe_expires_at=now()-interval '1 day' where id=$1", [failed.submission_id]);
    await mockControl({ mode: 'normal' });
    const retries = await Promise.all([script<IssueSubmissionResult>('create_github_issue', input), script<IssueSubmissionResult>('create_github_issue', input)]);
    expect(retries.every(result => result.submission_id === failed.submission_id)).toBe(true);
    const final = await script<IssueSubmissionResult>('create_github_issue', input);
    expect(final.status).toBe('published');
    const freshKeys = [randomUUID(), randomUUID()];
    const freshResults = await Promise.all(freshKeys.map(idempotency_key => script<IssueSubmissionResult>('create_github_issue', { ...input, idempotency_key })));
    expect(freshResults).toEqual([final, final]);
    const state = await mockState();
    expect(state.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(state.issues).toHaveLength(1);
    expect((await f.sql.query('select count(*)::int as count from public.issue_report_submissions where payload_digest=(select payload_digest from public.issue_report_submissions where id=$1)', [failed.submission_id])).rows[0].count).toBe(1);
    evidence.definitive_rejection_remedy = { failed, aged_before_retry_hours: 48, retries, final, concurrent_fresh_key_results: freshResults, post_count: 2, issue_count: 1 };
    scenarios.push({ name: 'definitive-rejection-remedy-concurrent-retry', passed: true });
  });

  it('keeps an accepted timeout unknown beyond 24 hours and reconciles its exact marker on page two', async () => {
    await mockControl({ reset: true, mode: 'timeout', visible: false });
    const input = { ...report(randomUUID()), idempotency_key: randomUUID() };
    const uncertain = await script<IssueSubmissionResult>('create_github_issue', input);
    expect(uncertain.status).toBe('unknown');
    expect(uncertain.issue_url).toBeUndefined();
    expect(uncertain.error).toMatchObject({ code: 'publication_unknown', retryable: true });
    expect(uncertain.error?.message).toContain('reconcile');
    expect(uncertain.error?.message).toContain('will not create another issue');
    await f.sql.query("update public.issue_report_submissions set dedupe_expires_at=now()-interval '1 hour',created_at=now()-interval '25 hours' where id=$1", [uncertain.submission_id]);
    const retry = await script<IssueSubmissionResult>('create_github_issue', { ...input, idempotency_key: randomUUID() });
    expect(retry.submission_id).toBe(uncertain.submission_id);
    expect(retry.status).toBe('unknown');
    expect(retry.issue_url).toBeUndefined();
    expect(retry.error).toMatchObject({ code: 'publication_unknown', retryable: true });
    expect((await mockState()).requests.filter(request => request.method === 'POST')).toHaveLength(1);
    await mockControl({ mode: 'normal', visible: true, markerPage: 2 });
    const recovered = await script<IssueSubmissionResult>('create_github_issue', input);
    expect(recovered).toEqual({ submission_id: uncertain.submission_id, status: 'published', issue_url: 'https://github.com/ariavasulin/OpenReimbursements/issues/9000' });
    const state = await mockState();
    expect(state.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(state.requests.some(request => request.method === 'GET' && new URL(request.path, 'http://fixture.local').searchParams.get('page') === '2')).toBe(true);
    evidence.timeout_reconciliation = { uncertain, retry_after_24_hours: retry, recovered, post_count: 1, reconciliation_pages: state.requests.filter(request => request.method === 'GET').map(request => Number(new URL(request.path, 'http://fixture.local').searchParams.get('page'))) };
    scenarios.push({ name: 'accepted-timeout-paginated-marker-reconciliation', passed: true });
  }, 60_000);

  it('rejects unconfirmed, target override, attachment, oversize, and known-secret requests before publication', async () => {
    await mockControl({ reset: true });
    for (const override of [{ confirmed: false }, { repository: 'other/repository' }, { attachment: 'data:image/png;base64,AAAA' }, { body: 'x'.repeat(16001) }, { body: process.env.DWS_GITHUB_ISSUES_TOKEN }]) {
      try {
        const result = await client.callTool({ name: 'execute_dws_script', arguments: { script_name: 'create_github_issue', input: { ...report(randomUUID()), ...override } } });
        expect(result.isError).toBe(true);
      } catch (error) {
        // Secret rejection happens before the SDK envelope and returns HTTP400.
        expect(override.body).toBe(process.env.DWS_GITHUB_ISSUES_TOKEN);
        expect(String(error)).not.toContain(process.env.DWS_GITHUB_ISSUES_TOKEN);
      }
    }
    const oversized = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ padding: 'x'.repeat(65536) }) });
    expect(oversized.status).toBe(413);
    expect((await mockState()).requests).toHaveLength(0);
    scenarios.push({ name: 'invalid-and-secret-issue-inputs-never-publish', passed: true });
  });
});
