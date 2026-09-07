import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { GET, POST } from '@/app/api/photos/repair/route';
import type { RepairReport } from '@/lib/photos/repair/run';

describe('real repair retention and convergence through isolated Storage (AC-9, AC-10)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  const secret = 'isolated-repair-cron';
  const previousSecret = process.env.CRON_SECRET;
  const reports: Array<{ scenario: string; status: number; report: RepairReport }> = [];
  const paths = new Set<string>();
  const photoIds = new Set<string>();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const day = 86_400_000;

  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `repair-${jobId}`, name: 'Repair fixtures' })).error).toBeNull();
    process.env.CRON_SECRET = secret;
  });
  beforeEach(async () => {
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1,
      photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/phase5-repair-responses.json', JSON.stringify({
      target: 'disposable localhost PostgreSQL 15, Auth and Storage', reports,
    }, null, 2));
    if (f) {
      await f.sql.query('delete from public.photos where id=any($1::uuid[])', [[...photoIds]]);
      if (paths.size) await f.admin.storage.from('photos').remove([...paths]);
      await f.close();
    }
  });

  async function object(path: string) {
    paths.add(path);
    expect((await f.admin.storage.from('photos').upload(path, bytes, { contentType: 'application/octet-stream' })).error).toBeNull();
    return path;
  }
  async function photo(state: 'active' | 'due' | 'retained', extra: Record<string, unknown> = {}) {
    const id = randomUUID(); photoIds.add(id);
    const originalPath = typeof extra.original_path === 'string' ? extra.original_path
      : await object(`originals/${f.employeeA.id}/${id}/fixture.bin`);
    const now = Date.now();
    const row = { id, job_id: jobId, uploader_id: f.employeeA.id, kind: 'file',
      captured_at: new Date(now).toISOString(), original_path: originalPath, original_bytes: bytes.length,
      ...(state === 'active' ? {} : {
        deleted_at: new Date(now - (state === 'due' ? 31 : 1) * day).toISOString(),
        deleted_by: f.employeeA.id,
        purge_after: new Date(now + (state === 'due' ? -1 : 29) * day).toISOString(),
      }), ...extra };
    expect((await f.admin.from('photos').insert(row)).error).toBeNull();
    return row;
  }
  async function exists(path: string) {
    const result = await f.admin.storage.from('photos').exists(path);
    return result.data;
  }
  async function row(id: string) {
    return (await f.sql.query('select * from public.photos where id=$1', [id])).rows[0];
  }
  async function run(scenario: string, method: 'GET' | 'POST' = 'POST', age?: number) {
    const response = await (method === 'GET' ? GET : POST)(new Request(
      `http://localhost:3000/api/photos/repair${age === undefined ? '' : `?olderThan=${age}`}`,
      { method, headers: { authorization: `Bearer ${secret}` } },
    ));
    const report = await response.json() as RepairReport;
    reports.push({ scenario, status: response.status, report });
    expect(report).toMatchObject({ counts: expect.any(Object), errors: expect.any(Array), planned: expect.any(Number),
      purged: expect.any(Number), purge_failed: expect.any(Number), work_deferred: expect.any(Number) });
    expect(report.purge_backlog === null || typeof report.purge_backlog === 'number').toBe(true);
    expect(report.oldest_due_at === null || Number.isFinite(Date.parse(report.oldest_due_at))).toBe(true);
    return { response, report };
  }

  it('rejects missing/wrong cron credentials and closed/absent gates on both GET and POST before work', async () => {
    const due = await photo('due');
    const before = await row(due.id);
    const progressBefore = (await f.sql.query('select * from photo_repair_progress')).rows;
    const network = vi.spyOn(globalThis, 'fetch');
    for (const method of ['GET', 'POST'] as const) {
      for (const authorization of ['', 'Bearer wrong']) {
        const response = await (method === 'GET' ? GET : POST)(new Request('http://localhost:3000/api/photos/repair', {
          method, headers: { authorization },
        }));
        expect(response.status).toBe(401);
      }
    }
    delete process.env.CRON_SECRET;
    try {
      for (const method of ['GET', 'POST'] as const) {
        expect((await (method === 'GET' ? GET : POST)(new Request('http://localhost:3000/api/photos/repair', {
          method, headers: { authorization: `Bearer ${secret}` },
        }))).status).toBe(401);
      }
    } finally { process.env.CRON_SECRET = secret; }
    expect(network).not.toHaveBeenCalled();
    await f.sql.query('update photo_release_state set repair_enabled=false');
    for (const method of ['GET', 'POST'] as const) {
      expect((await (method === 'GET' ? GET : POST)(new Request('http://localhost:3000/api/photos/repair', {
        method, headers: { authorization: `Bearer ${secret}` },
      }))).status).toBe(503);
    }
    await f.sql.query('delete from photo_release_state');
    for (const method of ['GET', 'POST'] as const) {
      expect((await (method === 'GET' ? GET : POST)(new Request('http://localhost:3000/api/photos/repair', {
        method, headers: { authorization: `Bearer ${secret}` },
      }))).status).toBe(503);
    }
    expect(network.mock.calls.every(([input]) => !String(input instanceof Request ? input.url : input).includes('/storage/v1/'))).toBe(true);
    expect(await row(due.id)).toEqual(before);
    expect((await f.sql.query('select * from photo_repair_progress')).rows).toEqual(progressBefore);
    network.mockRestore();
    await f.sql.query('delete from photos where id=$1', [due.id]);
  });

  it('keeps the row after partial HTTP deletion failure, then purges only after all unshared paths disappear', async () => {
    const active = await photo('active');
    const retained = await photo('retained');
    const suffix = randomUUID();
    const thumb = await object(`derived/${f.employeeA.id}/${suffix}_thumb.webp`);
    const playback = await object(`derived/${f.employeeA.id}/${suffix}_playback.mp4`);
    const due = await photo('due', { thumb_path: thumb, playback_path: playback,
      preview_path: active.original_path, sidecar_path: retained.original_path });
    const before = await row(due.id);
    const retainedBefore = await row(retained.id);
    const canonical = await photo('due');
    const alias = await photo('retained', { duplicate_of: canonical.id,
      legacy_content_sha256: createHash('sha256').update('legacy fixture').digest('hex') });
    const canonicalBefore = await row(canonical.id);
    const aliasBefore = await row(alias.id);
    const realFetch = globalThis.fetch;
    const deleted: string[] = [];
    const failures: string[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'DELETE' && new URL(request.url).pathname === '/storage/v1/object/photos') {
        const body = await request.clone().json() as { prefixes: string[] };
        if (body.prefixes.includes(playback)) {
          failures.push(playback);
          return new Response(JSON.stringify({ statusCode: '503', error: 'Service Unavailable', message: 'isolated forced deletion failure' }),
            { status: 503, headers: { 'content-type': 'application/json' } });
        }
        deleted.push(...body.prefixes);
      }
      return realFetch(input, init);
    });
    const failed = await run('partial Storage deletion failure');
    expect(failed.response.status).toBe(500);
    expect(failed.report.purge_failed).toBeGreaterThanOrEqual(1);
    expect(failed.report.purge_backlog).toBeGreaterThanOrEqual(2);
    expect(failed.report.errors.join(' ')).toContain('isolated forced deletion failure');
    expect(failures.length).toBeGreaterThan(0);
    expect(await row(due.id)).toMatchObject({ id: due.id, deleted_at: before.deleted_at, purge_after: before.purge_after });
    expect(await exists(playback)).toBe(true);
    expect(deleted).toContain(due.original_path);
    expect(await exists(due.original_path)).toBe(false);
    expect(await exists(thumb)).toBe(false);
    expect(deleted).not.toContain(active.original_path);
    expect(deleted).not.toContain(retained.original_path);
    expect(deleted).not.toContain(canonical.original_path);
    network.mockRestore();
    const retried = await run('retry after partial failure', 'GET');
    expect(retried.response.status, JSON.stringify(retried.report)).toBe(200);
    expect(retried.report.purged).toBeGreaterThanOrEqual(1);
    expect(await row(due.id)).toBeUndefined();
    expect(await exists(playback)).toBe(false);
    expect(await exists(active.original_path)).toBe(true);
    expect(await exists(retained.original_path)).toBe(true);
    expect(await row(retained.id)).toEqual(retainedBefore);
    expect(await row(canonical.id)).toEqual(canonicalBefore);
    expect(await row(alias.id)).toEqual(aliasBefore);
    expect(await exists(canonical.original_path)).toBe(true);
    expect(retried.report.purge_backlog).toBeGreaterThanOrEqual(1);
  });

  it('defers an overlapping real invocation while the first is paused at a Storage delete', async () => {
    const due = await photo('due');
    const realFetch = globalThis.fetch;
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let resume!: () => void; const resumed = new Promise<void>(resolve => { resume = resolve; });
    let deletes = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'DELETE' && new URL(request.url).pathname === '/storage/v1/object/photos') {
        const body = await request.clone().json() as { prefixes: string[] };
        if (body.prefixes.includes(due.original_path)) { deletes++; enter(); await resumed; }
      }
      return realFetch(input, init);
    });
    const first = run('overlap owner');
    try {
      await Promise.race([entered, first.then(() => { throw new Error('Repair returned without reaching the Storage delete seam'); })]);
      const overlap = await run('overlap deferred', 'GET');
      expect(overlap.response.status).toBe(200);
      expect(overlap.report.work_deferred).toBeGreaterThan(0);
      expect(overlap.report.purged).toBe(0);
      expect(await row(due.id)).toBeDefined();
      expect(await exists(due.original_path)).toBe(true);
    } finally { resume(); }
    const completed = await first;
    expect(completed.response.status, JSON.stringify(completed.report)).toBe(200);
    expect(deletes).toBe(1);
    expect(await row(due.id)).toBeUndefined();
  });

  it('protects unfinished attempt paths and a finalize committed after the real inventory response', async () => {
    const attemptId = randomUUID(); const photoId = randomUUID(); photoIds.add(photoId);
    const digest = createHash('sha256').update(bytes).digest('hex');
    async function rpc(name: string, args: Record<string, unknown>) {
      const result = await f.admin.rpc(name, args);
      expect(result.error, `${name}: ${result.error?.message}`).toBeNull();
      return result.data;
    }
    const attempt = await rpc('photo_create_upload_attempt', { p_actor: f.employeeA.id, p_job_id: jobId,
      p_source_signature: `repair-race:${attemptId}`, p_digest: digest,
      p_original_name: 'fixture.bin', p_original_bytes: bytes.length, p_mime_type: 'application/octet-stream',
      p_attempt_id: attemptId, p_photo_id: photoId });
    const owner = { p_actor: f.employeeA.id, p_owner_kind: 'ordinary', p_owner_id: attemptId };
    const lease = await rpc('photo_acquire_upload', owner);
    const claim = await rpc('photo_claim_content', { ...owner, p_generation: lease.lease_generation });
    expect(claim.status).toBe('claimed');
    await object(attempt.original_path);
    const beforeFinalize = await run('unfinished attempt is owned', 'POST', 0);
    expect(beforeFinalize.response.status, JSON.stringify(beforeFinalize.report)).toBe(200);
    expect(await row(photoId)).toBeUndefined();
    expect(await exists(attempt.original_path)).toBe(true);

    const realFetch = globalThis.fetch;
    let finalized = false;
    const deletes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (request.method === 'DELETE' && pathname === '/storage/v1/object/photos') {
        deletes.push(...(await request.clone().json() as { prefixes: string[] }).prefixes);
      }
      const response = await realFetch(input, init);
      if (!finalized && pathname === '/rest/v1/rpc/photo_repair_storage_page' && response.ok) {
        const inventory = await response.clone().json() as Array<{ name: string }>;
        if (inventory.some(entry => entry.name === attempt.original_path)) {
          // Real Storage inventory was read before finalization. Commit on a
          // separate HTTP/SQL connection before repair can authorize deletion.
          const result = await rpc('photo_finalize_upload', { ...owner, p_generation: lease.lease_generation,
            p_claim_generation: claim.claim_generation, p_photo: { kind: 'file' } });
          expect(result).toMatchObject({ status: 'created', photo_id: photoId });
          finalized = true;
        }
      }
      return response;
    });
    const raced = await run('finalize after inventory snapshot', 'POST', 0);
    expect(raced.response.status, JSON.stringify(raced.report)).toBe(200);
    expect(finalized).toBe(true);
    expect(deletes).not.toContain(attempt.original_path);
    expect(await row(photoId)).toMatchObject({ id: photoId, content_sha256: digest, deleted_at: null });
    expect(await exists(attempt.original_path)).toBe(true);
  });

  it('defers when purge inventory consumes the shared deadline and resumes on a fresh invocation', async () => {
    const due = await photo('due');
    const realNow = Date.now.bind(Date);
    const started = realNow();
    let now = started;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const realFetch = globalThis.fetch;
    let exhausted = false;
    const deletes: string[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (request.method === 'DELETE' && pathname === '/storage/v1/object/photos') {
        deletes.push(...(await request.clone().json() as { prefixes: string[] }).prefixes);
      }
      const response = await realFetch(input, init);
      if (pathname === '/rest/v1/rpc/photo_repair_claim_purge' && response.ok) {
        exhausted = true;
        now = started + 240_000;
      }
      return response;
    });
    const deferred = await run('deadline consumed during purge inventory');
    expect(exhausted).toBe(true);
    expect(deferred.response.status, JSON.stringify(deferred.report)).toBe(200);
    expect(deferred.report.errors).toEqual([]);
    expect(deferred.report.work_deferred).toBeGreaterThanOrEqual(1);
    expect(deferred.report.purge_backlog).toBeGreaterThanOrEqual(1);
    expect(deletes).not.toContain(due.original_path);
    expect(await row(due.id)).toBeDefined();
    expect(await exists(due.original_path)).toBe(true);
    network.mockRestore();
    vi.spyOn(Date, 'now').mockImplementation(realNow);
    const resumed = await run('deadline deferred purge resumes');
    expect(resumed.response.status, JSON.stringify(resumed.report)).toBe(200);
    expect(resumed.report.purged).toBeGreaterThanOrEqual(1);
    expect(await row(due.id)).toBeUndefined();
    expect(await exists(due.original_path)).toBe(false);
  });
});
