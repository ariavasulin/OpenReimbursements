import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../../../scripts/photo-identity-cutover.mjs';

const base = ['--project-ref', 'fixture', '--output', '/tmp/cutover-report.json'];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('cutover CLI fail-closed invocation boundary', () => {
  it('defaults to dry-run and requires explicit execute for each mutation mode', () => {
    expect(parseArgs(base).mode).toBe('dry-run');
    for (const mode of ['mapping', 'resume', 'rollback']) {
      expect(parseArgs([...base, `--${mode}`, '/tmp/input.json', '--execute']).mode).toBe(mode);
      expect(() => parseArgs([...base, `--${mode}`, '/tmp/input.json'])).toThrow();
    }
  });
  it.each([
    ['--execute'], ['--dry-run', '--execute'], ['--mapping', '/tmp/input', '--execute', '--dry-run'],
    ['--resume', '/tmp/input', '--rollback', '/tmp/input', '--execute'],
    ['--mapping', '/tmp/input', '--resume', '/tmp/input', '--execute'],
    ['--execute', '--execute'], ['--unknown'], ['--mapping'],
  ])('rejects ambiguous or malformed options %j', (...args) => {
    expect(() => parseArgs([...base, ...args])).toThrow();
  });
  it('requires target and report before any connection', () => {
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['--project-ref', 'fixture'])).toThrow();
  });
  it('rejects metadata in the repository before network access', async () => {
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    await expect(main(['--project-ref', 'fixture', '--output', resolve('test-results/private-cutover.json')])).rejects.toThrow('outside git');
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects project mismatch and production fault injection before network access', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'cutover-cli-')); directories.push(directory);
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    vi.stubEnv('SUPABASE_URL', 'https://different.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key');
    const args = ['--project-ref', 'fixture', '--output', resolve(directory, 'report.json')];
    await expect(main(args)).rejects.toThrow('does not match');
    vi.stubEnv('SUPABASE_URL', 'https://fixture.supabase.co');
    vi.stubEnv('DWS_CUTOVER_TEST_CRASH_AFTER_COMMIT', '1');
    await expect(main(args)).rejects.toThrow('isolated loopback');
    expect(network).not.toHaveBeenCalled();
  });
  it('refuses a resume report that would overwrite its before-image', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'cutover-cli-')); directories.push(directory);
    const before = resolve(directory, 'before.json');
    const checkpoint = resolve(directory, 'checkpoint.json');
    await writeFile(checkpoint, JSON.stringify({ version: 1, project_ref: 'fixture', before_image: before,
      run_id: 'synthetic', mapping: { version: 1, project_ref: 'fixture', groups: [] } }));
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('SUPABASE_URL', 'https://fixture.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key');
    await expect(main(['--project-ref', 'fixture', '--output', before, '--resume', checkpoint, '--execute'])).rejects.toThrow('overwrite');
    expect(network).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves full dry-run group reports with schema_ready=%s', async schemaReady => {
    const directory = await mkdtemp(resolve(tmpdir(), 'cutover-cli-')); directories.push(directory);
    vi.stubEnv('SUPABASE_URL', 'https://fixture.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const digest = 'a'.repeat(64);
    const rows = [
      { id: '1', content_sha256: digest, job_id: 'job-a', original_path: 'original/a', tags: ['keep'] },
      { id: '2', content_sha256: digest, job_id: 'job-b', original_path: 'original/b', tags: [] },
      { id: '3', content_sha256: 'b'.repeat(64), job_id: 'job-a', original_path: 'original/unique', tags: [] },
      { id: '4', content_sha256: null, job_id: 'job-b', original_path: 'original/null', tags: [] },
    ].map(row => schemaReady ? { ...row, legacy_content_sha256: null } : row);
    const queries: URL[] = [];
    const network = vi.fn(async (input: string, options: RequestInit) => {
      const url = new URL(input); queries.push(url);
      if (url.pathname.endsWith('/rpc/photo_cutover_snapshot')) {
        if (!schemaReady) return Response.json({ code: 'PGRST202' }, { status: 404 });
        const { p_digest } = JSON.parse(options.body as string);
        return Response.json({ digest: p_digest, rows: rows.filter(row => row.content_sha256 === p_digest), expected_before_image_digest: 'authoritative-before-image' });
      }
      expect(url.pathname).toBe('/rest/v1/photos');
      expect(options.method).toBe('GET');
      expect(url.searchParams.get('select')).toBe(schemaReady ? 'id,content_sha256,legacy_content_sha256' : '*');
      // A server cap smaller than requested must still advance through all pages.
      const after = url.searchParams.get('id')?.slice(3) ?? '';
      const page = rows.filter(row => row.id > after).slice(0, 2);
      return Response.json(schemaReady ? page.map(row => ({ id: row.id, content_sha256: row.content_sha256, legacy_content_sha256: null })) : page);
    });
    vi.stubGlobal('fetch', network);
    const output = resolve(directory, 'dry-run.json');
    await main(['--project-ref', 'fixture', '--output', output]);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(queries[0].pathname).toBe('/rest/v1/rpc/photo_cutover_snapshot');
    expect(queries.filter(url => url.pathname.endsWith('/photos'))).toHaveLength(3);
    expect(report).toEqual({ version: 1, project_ref: 'fixture', mode: 'dry-run', schema_ready: schemaReady,
      observed_at: expect.any(String), snapshot_consistency: 'paged; repeat under closed gates before approval',
      totals: { photos: 4, legacy_null_hashes: 1, indexed_hashes: 3, duplicate_groups: 1, duplicate_rows: 2 },
      groups: [{ digest, rows: rows.slice(0, 2), expected_before_image_digest: schemaReady ? 'authoritative-before-image' : null }],
      elapsed_ms: expect.any(Number), next_action: schemaReady
        ? 'Administrator reviews explicit canonical choices; close gates/install boundary before execute'
        : 'Legacy read-only preflight; apply additive schema, then repeat dry run before approving a mapping' });
  });

});
