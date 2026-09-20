import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), issue: vi.fn() }));
vi.mock('@/lib/supabaseAdminClient', () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock('./issues', async importOriginal => ({ ...await importOriginal<typeof import('./issues')>(), executeCreateGithubIssue: mocks.issue }));
import { browserOrigin, createDwsMcpServer, scriptNames, validateScriptInput } from './registry';
import { IssueSubmissionError } from './issues';
import { harnessInstructions, skills } from './harness';

beforeEach(() => {
  vi.stubEnv('DWS_BROWSER_ORIGIN', 'https://photos.dws-receipts.com');
  vi.stubEnv('MCP_SHARED_KEY', 'a'.repeat(64));
  mocks.rpc.mockImplementation(async () => ({ data: new Date(Date.now() + 30 * 60 * 1000).toISOString(), error: null }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('MCP registry', () => {
  it('allows only fixed script schemas and validates complete inputs before persistence', () => {
    expect(scriptNames).toEqual(['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos', 'create_github_issue']);
    const invalid: Array<Parameters<typeof validateScriptInput>> = [
      ['migrate_photos', { sources: [{ label: 'valid', arbitrary: true }] }],
      ['add_photos', { job_number: '3612', attachments: ['file:///tmp/photo.jpg'] }],
      ['move_photos', { selector: { job_number: '3612', scope: 'active' } }],
      ['remove_photos', { selector: { photos: [] } }],
      ['restore_photos', { selector: { photos: [{ photo_id: 'not-a-uuid' }] } }],
      ['remove_photos', { selector: { photos: [{ photo_url: 'https://evil.example/photos/fake?photo=fake' }] } }],
      ['migrate_photos', { sources: [{ label: 'a'.repeat(64) }] }],
      ['create_github_issue', { title: 'Report', body: 'Details', anonymous: true, kind: 'bug', confirmed: false }],
    ];
    for (const [name, input] of invalid) expect(() => validateScriptInput(name, input)).toThrow();
    // A suggested project name is a browser-side suggestion only; it must pass validation unchanged.
    expect(validateScriptInput('add_photos', { new_project_name: 'Office party' })).toEqual({ new_project_name: 'Office party' });
    expect(validateScriptInput('migrate_photos', { sources: [{ label: 'Party', new_project_name: 'Office party' }] }))
      .toEqual({ sources: [{ label: 'Party', new_project_name: 'Office party' }] });
    expect(() => validateScriptInput('add_photos', { new_project_name: 'x'.repeat(121) })).toThrow();
    for (const name of ['eval', '__proto__', 'constructor', 'toString', '../photos', 'add_photos/../../eval']) {
      expect(() => validateScriptInput(name, {})).toThrow();
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('permits unknown job hints and valid app references without looking them up', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    expect(validateScriptInput('move_photos', {
      selector: { photos: [{ photo_url: `/photos/${id}?photo=${id}` }] }, destination_job_number: 'unknown-yet',
    })).toHaveProperty('destination_job_number', 'unknown-yet');
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('falls back to the design-workshops photo host when no origin is configured', () => {
    vi.stubEnv('DWS_BROWSER_ORIGIN', undefined);
    expect(browserOrigin()).toBe('https://photos.design-workshops.app');
  });
  it('requires a plain configured origin and never puts configured secrets into browser URLs', () => {
    for (const origin of ['https://evil.example/path', 'https://user:password@example.test', `https://${'a'.repeat(64)}.example.test`]) {
      vi.stubEnv('DWS_BROWSER_ORIGIN', origin);
      expect(() => browserOrigin()).toThrow();
    }
  });
  it('publishes exactly two tools, both skills, and five independent hashed photo handoffs', async () => {
    const server = createDwsMcpServer();
    const client = new Client({ name: 'registry-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(['load_dws_skill', 'execute_dws_script']);
      expect(client.getInstructions()).toBe(harnessInstructions);
      const [loader, executor] = tools.tools;
      for (const skill of Object.values(skills)) expect(loader.description).toContain(skill.description);
      for (const name of scriptNames) expect(JSON.stringify(tools)).not.toContain(name);
      expect(executor.inputSchema.properties?.script_name).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
      expect(executor.inputSchema.properties?.script_name).not.toHaveProperty('enum');
      for (const skill_name of ['photos', 'report_issue']) {
        const response = await client.callTool({ name: 'load_dws_skill', arguments: { skill_name } });
        const skill = JSON.parse((response.content as Array<{text:string}>)[0].text);
        expect(skill.instructions).toBe(skills[skill_name as keyof typeof skills].instructions);
        expect(skill.harness_instructions).toBe(harnessInstructions);
        expect(skill.scripts.map((script: {script_name:string}) => script.script_name)).toEqual(
          skill_name === 'photos' ? scriptNames.slice(0, 5) : ['create_github_issue']);
        for (const script of skill.scripts) {
          expect(script.description.trim()).not.toBe('');
          expect(script.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
        }
        if (skill_name === 'photos') expect(skill.scripts.find((script: {script_name:string}) => script.script_name === 'move_photos').input_schema.required).toEqual(['selector', 'destination_job_number']);
        else expect(skill.scripts[0].input_schema.properties.confirmed).toMatchObject({ const: true });
      }
      const tokens = new Set<string>();
      const scripts = ['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos'] as const;
      for (const script_name of scripts) {
        const input = script_name === 'migrate_photos' || script_name === 'add_photos' ? {} : {
          selector: { job_number: 'unresolved', scope: 'active' },
          ...(script_name === 'move_photos' ? { destination_job_number: 'another-unresolved-job' } : {}),
        };
        const response = await client.callTool({ name: 'execute_dws_script', arguments: { script_name, input } });
        expect(response.isError).not.toBe(true);
        const handoff = JSON.parse((response.content as Array<{text:string}>)[0].text);
        expect(Object.keys(handoff).sort()).toEqual(['expires_at', 'handoff_url']);
        const url = new URL(handoff.handoff_url);
        const token = url.searchParams.get('token')!;
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        tokens.add(token);
        expect(url.searchParams.get('script_name')).toBe(script_name);
        expect(url.pathname).toBe(script_name === 'migrate_photos' || script_name === 'add_photos' ? '/migrate' : '/photo-actions');
        expect(Date.parse(handoff.expires_at) - Date.now()).toBeGreaterThan(29 * 60 * 1000);
        expect(mocks.rpc).toHaveBeenLastCalledWith('create_dws_handoff', { p_token_digest: createHash('sha256').update(token).digest('hex'), p_script_name: script_name, p_requested_input: input });
        expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(token);
      }
      expect(tokens.size).toBe(5);
      expect(mocks.from).not.toHaveBeenCalled();
      for (const script_name of ['eval', '__proto__', 'constructor', 'toString', '../photos', 'x'.repeat(65)]) {
        const invalid = await client.callTool({ name: 'execute_dws_script', arguments: { script_name, input: { code: 'globalThis.pwned=true' } } });
        expect(invalid.isError).toBe(true);
      }
      expect(mocks.rpc).toHaveBeenCalledTimes(5);
      expect(mocks.issue).not.toHaveBeenCalled();
      for (const call of [
        { name: 'unknown_tool', arguments: {} },
        { name: 'load_dws_skill', arguments: { skill_name: 'unknown_skill' } },
      ]) {
        const rejected = await client.callTool(call);
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).not.toContain('instructions');
      }
      mocks.issue.mockRejectedValueOnce(new IssueSubmissionError('conflict'));
      const conflict = await client.callTool({ name: 'execute_dws_script', arguments: { script_name: 'create_github_issue', input: {
        title: 'Changed', body: 'Changed report', kind: 'bug', anonymous: true, confirmed: true,
      } } });
      expect(conflict.isError).toBe(true);
      expect(JSON.parse((conflict.content as Array<{text:string}>)[0].text).error.code).toBe('conflict');
    } finally { await client.close(); await server.close(); }
  });
});
