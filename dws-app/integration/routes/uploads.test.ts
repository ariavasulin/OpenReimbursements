import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { withRequest } from './request-context';
import type { FinalizeUploadInput, UploadAttempt } from '@/lib/photos/upload-contract';

vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return {
    cookies: async () => ({
      get: (name: string) => { const value = requestContext.getStore()!.cookies.get(name); return value === undefined ? undefined : { name, value }; },
      set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); },
    }),
    headers: async () => requestContext.getStore()!.headers,
  };
});
import { POST as attempt } from '@/app/api/photo-migrations/uploads/attempt/route';
import { POST as acquire } from '@/app/api/photo-migrations/uploads/acquire/route';
import { POST as claim } from '@/app/api/photo-migrations/uploads/claim/route';
import { POST as renew } from '@/app/api/photo-migrations/uploads/renew/route';
import { POST as release } from '@/app/api/photo-migrations/uploads/release/route';
import { POST as cancel } from '@/app/api/photo-migrations/uploads/cancel/route';
import { POST as original } from '@/app/api/photo-migrations/uploads/original/route';
import { POST as attach } from '@/app/api/photo-migrations/uploads/sidecar/route';
import { POST as finalize } from '@/app/api/photos/route';
import { GET as exists } from '@/app/api/photos/exists/route';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';

describe('shared upload HTTP boundaries with real Auth, SQL and Storage (AC-4, AC-5, AC-6, AC-10)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `routes-upload-${jobId}`, name: 'Upload routes' })).error).toBeNull();
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
  });
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); });
  async function call(handler: (r: Request) => Promise<Response>, body: unknown, actor = f.employeeA, origin = 'http://localhost:3000') {
    const request = new Request('http://localhost:3000/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return withRequest(request, actor.cookies, () => handler(request));
  }
  async function ok(handler: (r: Request) => Promise<Response>, body: unknown) {
    const response = await call(handler, body); const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200); return result;
  }
  async function fresh(bytes = randomBytes(8), destination = jobId) {
    const id = randomUUID(); const photoId = randomUUID(); const digest = createHash('sha256').update(bytes).digest('hex');
    const input = { attempt_id: id, photo_id: photoId, job_id: destination, source_signature: `route:${id}`,
      content_sha256: digest, original_name: 'fixture.jpg', original_bytes: bytes.length, mime_type: 'image/jpeg' };
    const created = await ok(attempt, input) as UploadAttempt;
    const owner = { owner_kind: created.owner_kind, owner_id: created.owner_id };
    const lease = await ok(acquire, owner);
    return { input, created, owner, lease, bytes };
  }
  async function prepared() {
    const value = await fresh(); const claimed = await ok(claim, { ...value.owner, lease_generation: value.lease.lease_generation });
    expect(claimed.status).toBe('claimed');
    const payload: FinalizeUploadInput = { ...value.owner, lease_generation: value.lease.lease_generation, claim_generation: claimed.claim_generation,
      id: value.created.photo_id, job_id: jobId, kind: 'image', tags: [], captured_at: null, captured_at_source: 'upload',
      original_path: value.created.original_path, original_bytes: value.bytes.length, mime_type: 'image/jpeg', original_name: 'fixture.jpg',
      thumb_path: null, preview_path: null, duration_secs: null, sidecar_path: null, sidecar_name: null, content_sha256: value.input.content_sha256, warnings: [] };
    const bound = await f.admin.rpc('photo_lock_upload', { p_actor: f.employeeA.id, p_owner_kind: value.owner.owner_kind, p_owner_id: value.owner.owner_id });
    expect(bound.error).toBeNull();
    expect(bound.data).toMatchObject({ photo_id: payload.id, job_id: payload.job_id, content_sha256: payload.content_sha256, original_path: payload.original_path, original_bytes: payload.original_bytes, original_name: payload.original_name, mime_type: payload.mime_type });
    return { ...value, payload };
  }
  async function upload(value: Awaited<ReturnType<typeof prepared>>) {
    expect((await f.employeeA.client.storage.from('photos').upload(value.created.original_path, value.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
  }
  async function canonical(value: Awaited<ReturnType<typeof prepared>>, trashed = false) {
    const id = randomUUID(); const path = `originals/${f.employeeB.id}/${id}/canonical.jpg`; const now = Date.now();
    expect((await f.employeeB.client.storage.from('photos').upload(path, value.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeB.id, kind: 'image', captured_at: new Date(now).toISOString(),
      original_path: path, original_bytes: value.bytes.length, content_sha256: value.input.content_sha256,
      ...(trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id, purge_after: new Date(now + 30 * 86400000).toISOString() } : {}) })).error).toBeNull();
    return { id, path };
  }

  it('requires same-origin verified actors, rejects stale clients and denies wrong attempt owners', async () => {
    const value = await prepared();
    expect((await call(finalize, value.payload, f.employeeA, 'https://attacker.example')).status).toBe(403);
    const anonymous = new Request('http://localhost:3000/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(value.payload) });
    expect((await withRequest(anonymous, [], () => finalize(anonymous))).status).toBe(401);
    expect((await call(finalize, { id: value.created.photo_id })).status).toBe(409);
    expect((await call(finalize, value.payload, f.employeeB)).status).toBe(403);
    expect((await call(acquire, value.owner, f.employeeB)).status).toBe(403);
    expect((await call(release, { ...value.owner, lease_generation: value.lease.lease_generation, status: 'cancelled' }, f.employeeB)).status).toBe(403);
  });

  it('cancels only owned ordinary attempts behind verified origin, actor, and write gates', async () => {
    const value = await prepared(); const input = { ...value.input, owner_kind: 'ordinary' };
    expect((await call(cancel, input, f.employeeA, 'https://attacker.example')).status).toBe(403);
    const anonymous = new Request('http://localhost:3000/api/photo-migrations/uploads/cancel', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(input) });
    expect((await withRequest(anonymous, [], () => cancel(anonymous))).status).toBe(401);
    expect((await call(cancel, input, f.employeeB)).status).toBe(403);
    expect((await call(cancel, input, f.administrator)).status).toBe(403);
    expect((await call(cancel, { ...input, owner_kind: 'migration' })).status).toBe(400);
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: false }).eq('singleton', true)).error).toBeNull();
    expect((await call(cancel, input)).status).toBe(503);
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true }).eq('singleton', true)).error).toBeNull();
    expect(await ok(cancel, input)).toEqual({ status: 'cancelled' });
    expect(await ok(cancel, input)).toEqual({ status: 'cancelled' });
    expect((await call(acquire, value.owner)).status).toBe(409);
    expect((await call(release, { ...value.owner, lease_generation: value.lease.lease_generation, status: 'retryable_failed' })).status).toBe(409);
    expect((await f.admin.from('photo_upload_attempts').select('status,lease_expires_at').eq('id', value.owner.owner_id).single()).data)
      .toEqual({ status: 'cancelled', lease_expires_at: null });
    expect((await f.admin.from('photo_content_claims').select('content_sha256').eq('upload_attempt_id', value.owner.owner_id)).data).toEqual([]);
  });

  it('settles cancellation before attempt creation and fences a delayed create response', async () => {
    const id = randomUUID(); const photoId = randomUUID();
    const input = { owner_kind: 'ordinary', attempt_id: id, photo_id: photoId, job_id: jobId,
      source_signature: `pre-create:${id}`, content_sha256: randomBytes(32).toString('hex'),
      original_name: 'fixture.jpg', original_bytes: 8, mime_type: 'image/jpeg' };
    expect(await ok(cancel, input)).toEqual({ status: 'cancelled' });
    // A previously dispatched creation may reach SQL only after cancellation.
    expect(await ok(attempt, input)).toMatchObject({ owner_id: id, photo_id: photoId });
    expect((await call(acquire, { owner_kind: 'ordinary', owner_id: id })).status).toBe(409);
    expect((await f.admin.from('photo_upload_attempts').select('status').eq('id', id).single()).data).toEqual({ status: 'cancelled' });
    expect((await f.admin.from('photos').select('id').eq('id', photoId)).data).toEqual([]);
  });

  it('waits for an uncommitted create before acknowledging durable cancellation', async () => {
    const id = randomUUID(); const photoId = randomUUID();
    const input = { owner_kind: 'ordinary', attempt_id: id, photo_id: photoId, job_id: jobId,
      source_signature: `inflight-create:${id}`, content_sha256: randomBytes(32).toString('hex'),
      original_name: 'fixture.jpg', original_bytes: 8, mime_type: 'image/jpeg' };
    const connection = await f.sql.connect();
    let pending: Promise<Response> | undefined;
    try {
      await connection.query('begin');
      const pid = (await connection.query('select pg_backend_pid() as pid')).rows[0].pid;
      await connection.query('select public.photo_create_upload_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [f.employeeA.id, jobId, input.source_signature, input.content_sha256, input.original_name,
          input.original_bytes, input.mime_type, id, photoId]);
      let settled = false;
      pending = call(cancel, input).then(response => { settled = true; return response; });
      await vi.waitFor(async () => {
        const waiting = await f.sql.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid]);
        expect(waiting.rows.length).toBeGreaterThan(0);
      }, { timeout: 5000 });
      expect(settled).toBe(false);
      await connection.query('commit');
      const response = await pending;
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: 'cancelled' });
      expect((await call(acquire, { owner_kind: 'ordinary', owner_id: id })).status).toBe(409);
    } finally {
      await connection.query('rollback'); connection.release();
      await pending;
    }
  });

  it('preserves commit-first photo and XMP warnings, while cancel-first fences finalization', async () => {
    const committed = await prepared(); await upload(committed);
    committed.payload.sidecar_path = committed.created.sidecar_path; committed.payload.sidecar_name = 'fixture.xmp';
    const result = await ok(finalize, committed.payload);
    expect(result.sidecar_retry).toBe(true);
    expect(await ok(cancel, { ...committed.input, owner_kind: 'ordinary' })).toEqual(result);
    expect((await f.admin.from('photos').select('deleted_at').eq('id', committed.created.photo_id).single()).data).toEqual({ deleted_at: null });
    expect((await f.admin.storage.from('photos').info(committed.created.original_path)).error).toBeNull();

    const cancelled = await prepared(); await upload(cancelled);
    expect(await ok(cancel, { ...cancelled.input, owner_kind: 'ordinary' })).toEqual({ status: 'cancelled' });
    expect((await call(finalize, cancelled.payload)).status).toBe(409);
    expect((await f.admin.from('photos').select('id').eq('id', cancelled.created.photo_id)).data).toEqual([]);
  });

  it('serializes concurrent cancellation/finalize into cancellation or an intact canonical photo', async () => {
    const value = await prepared(); await upload(value);
    const [cancelResponse, finalizeResponse] = await Promise.all([
      call(cancel, { ...value.input, owner_kind: 'ordinary' }), call(finalize, value.payload),
    ]);
    expect(cancelResponse.status).toBe(200);
    const outcome = await cancelResponse.json();
    if (outcome.status === 'cancelled') {
      expect(finalizeResponse.status).toBe(409);
      expect((await f.admin.from('photos').select('id').eq('id', value.created.photo_id)).data).toEqual([]);
    } else {
      expect(outcome).toMatchObject({ status: 'created', photo_id: value.created.photo_id });
      expect(finalizeResponse.status).toBe(200);
      expect((await f.admin.from('photos').select('deleted_at').eq('id', value.created.photo_id).single()).data).toEqual({ deleted_at: null });
      expect((await f.admin.storage.from('photos').info(value.created.original_path)).error).toBeNull();
    }
  });

  it('requires original metadata independently, and SQL also rejects a forged successful metadata response', async () => {
    const value = await prepared();
    expect((await call(finalize, value.payload)).status).toBe(409);
    const storageClient = supabaseAdmin.storage;
    vi.spyOn(supabaseAdmin, 'storage', 'get').mockReturnValue(storageClient);
    const storage = storageClient.from.bind(storageClient);
    let reportedSize = value.bytes.length + 1;
    const spy = vi.spyOn(storageClient, 'from').mockImplementation(bucket => {
      const client = storage(bucket);
      vi.spyOn(client, 'info').mockImplementation(async () => ({ data: { size: reportedSize }, error: null } as never));
      return client;
    });
    expect((await call(finalize, value.payload)).status).toBe(409);
    reportedSize = value.bytes.length;
    // The independent SQL metadata check prevents this fake from admitting absent bytes.
    expect((await call(finalize, value.payload)).status).toBe(503);
    spy.mockRestore();
    expect((await f.employeeA.client.storage.from('photos').upload(value.created.original_path, new Uint8Array([1]), { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await call(finalize, value.payload)).status).toBe(409);
    expect((await f.admin.from('photos').select('id').eq('id', value.created.photo_id)).data).toEqual([]);
  });

  it.each([false, true])('settles all concurrent metadata probes before finalize/response (rejection=%s)', async rejectFirst => {
    const value = await prepared(); await upload(value);
    value.payload.thumb_path = value.created.thumb_path;
    value.payload.preview_path = value.created.preview_path;
    value.payload.sidecar_path = value.created.sidecar_path;
    value.payload.sidecar_name = 'fixture.xmp';
    const probes: Array<{ path: string; resolve: (value: never) => void; reject: (error: Error) => void }> = [];
    const storageClient = supabaseAdmin.storage;
    vi.spyOn(supabaseAdmin, 'storage', 'get').mockReturnValue(storageClient);
    const from = storageClient.from.bind(storageClient);
    vi.spyOn(storageClient, 'from').mockImplementation(bucket => {
      const client = from(bucket), info = client.info.bind(client);
      vi.spyOn(client, 'info').mockImplementation(path => path === value.created.original_path ? info(path)
        : new Promise((resolve, reject) => probes.push({ path, resolve, reject })));
      return client;
    });
    const rpc = vi.spyOn(supabaseAdmin, 'rpc');
    let responded = false;
    const response = call(finalize, value.payload).then(result => { responded = true; return result; });
    await vi.waitFor(() => expect(probes).toHaveLength(3));
    expect(probes.map(probe => probe.path)).toEqual([value.created.thumb_path, value.created.preview_path, value.created.sidecar_path]);
    if (rejectFirst) probes[0].reject(new Error('isolated metadata failure'));
    else probes[0].resolve({ data: null, error: { status: 404 } } as never);
    probes[2].resolve({ data: null, error: { status: 404 } } as never);
    await new Promise(resolve => setImmediate(resolve));
    expect(responded).toBe(false);
    expect(rpc.mock.calls.some(([name]) => name === 'photo_finalize_upload')).toBe(false);
    probes[1].resolve({ data: null, error: { status: 404 } } as never);
    const result = await response;
    expect(result.status).toBe(rejectFirst ? 503 : 200);
    expect(rpc.mock.calls.filter(([name]) => name === 'photo_finalize_upload')).toHaveLength(rejectFirst ? 0 : 1);
    if (!rejectFirst) expect((await result.json()).warnings).toEqual([
      'Thumbnail upload failed; the original is preserved.', 'Preview upload failed; the original is preserved.',
      'Sidecar upload failed. Reselect the sidecar to retry.',
    ]);
  });

  it('retains original plus persistent sidecar/derivative warnings and permits exact lost-response replay only', async () => {
    const value = await prepared(); await upload(value);
    value.payload.sidecar_path = value.created.sidecar_path; value.payload.sidecar_name = 'fixture.xmp';
    value.payload.thumb_path = value.created.thumb_path; value.payload.preview_path = value.created.preview_path;
    value.payload.warnings = ['metadata_skipped'];
    const result = await ok(finalize, value.payload);
    expect(result.sidecar_retry).toBe(true);
    expect(result).toMatchObject({ status: 'created', photo_id: value.created.photo_id,
      warnings: ['metadata_skipped', 'Thumbnail upload failed; the original is preserved.', 'Preview upload failed; the original is preserved.', 'Sidecar upload failed. Reselect the sidecar to retry.'] });
    expect(await ok(finalize, value.payload)).toEqual(result);
    expect((await call(finalize, { ...value.payload, tags: ['changed'] })).status).toBe(409);
    expect((await call(finalize, { ...value.payload, content_sha256: randomBytes(32).toString('hex') })).status).toBe(409);
    const row = await f.admin.from('photos').select('original_path,sidecar_path,thumb_path,preview_path,upload_warnings').eq('id', value.created.photo_id).single();
    expect(row.data).toEqual({ original_path: value.created.original_path, sidecar_path: null, thumb_path: null, preview_path: null, upload_warnings: result.warnings });
  });

  it('removes late duplicate attempt objects after commit using service credentials, preserves canonical bytes and replays after deletion', async () => {
    const value = await prepared(); await upload(value); const existing = await canonical(value);
    const storageClient = supabaseAdmin.storage;
    vi.spyOn(supabaseAdmin, 'storage', 'get').mockReturnValue(storageClient);
    const storage = storageClient.from.bind(storageClient); let deletes = 0;
    vi.spyOn(storageClient, 'from').mockImplementation(bucket => {
      const client = storage(bucket); const remove = client.remove.bind(client);
      vi.spyOn(client, 'remove').mockImplementation(async paths => {
        deletes++;
        // A separate database connection observes committed result before delete starts.
        const committed = await f.sql.query('select result,lease_expires_at from photo_upload_attempts where id=$1', [value.owner.owner_id]);
        expect(committed.rows[0]).toMatchObject({ result: { status: 'duplicate_active', photo_id: existing.id }, lease_expires_at: null });
        expect(paths).not.toContain(existing.path);
        return remove(paths);
      });
      return client;
    });
    const result = await ok(finalize, value.payload);
    expect(result).toMatchObject({ status: 'duplicate_active', photo_id: existing.id }); expect(deletes).toBe(1);
    expect((await f.admin.storage.from('photos').info(value.created.original_path)).error).not.toBeNull();
    expect((await f.admin.storage.from('photos').info(existing.path)).error).toBeNull();
    expect(await ok(finalize, value.payload)).toEqual(result);
  });

  it('preserves shared references and canonical success when service-role cleanup is denied, then retries cleanup', async () => {
    const value = await prepared(); await upload(value); const existing = await canonical(value, true);
    const sharedId = randomUUID();
    expect((await f.employeeA.client.storage.from('photos').upload(value.created.thumb_path, new Uint8Array([1]), { contentType: 'image/webp' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id: sharedId, job_id: jobId, uploader_id: f.employeeA.id, kind: 'image',
      captured_at: new Date().toISOString(), original_path: value.created.thumb_path })).error).toBeNull();
    const storageClient = supabaseAdmin.storage;
    vi.spyOn(supabaseAdmin, 'storage', 'get').mockReturnValue(storageClient);
    const storage = storageClient.from.bind(storageClient);
    const spy = vi.spyOn(storageClient, 'from').mockImplementation(bucket => {
      const client = storage(bucket);
      vi.spyOn(client, 'remove').mockImplementation(async paths => {
        expect(paths).toContain(value.created.original_path); expect(paths).not.toContain(value.created.thumb_path); expect(paths).not.toContain(existing.path);
        return { data: null, error: { name: 'StorageApiError', message: 'fixture denied', statusCode: '403' } } as never;
      });
      return client;
    });
    const result = await ok(finalize, value.payload);
    // Another employee's unexpired trash: any signed-in employee may restore it (photo-albums Decision 7).
    expect(result).toMatchObject({ status: 'duplicate_trashed', photo_id: existing.id, cleanup_pending: true, can_restore: true });
    expect(result.remedy).toBe('Confirm restoration before uploading.');
    expect((await f.admin.storage.from('photos').info(value.created.original_path)).error).toBeNull();
    spy.mockRestore();
    const replay = await ok(finalize, value.payload); expect(replay).not.toHaveProperty('cleanup_pending');
    expect((await f.admin.storage.from('photos').info(value.created.original_path)).error).not.toBeNull();
    expect((await f.admin.storage.from('photos').info(value.created.thumb_path)).error).toBeNull();
    expect((await f.admin.storage.from('photos').info(existing.path)).error).toBeNull();
  });

  it('persists preflight same-job, cross-job and trash outcomes and never creates duplicate original objects', async () => {
    const first = await prepared(); await upload(first); await ok(finalize, first.payload);
    const otherJob = randomUUID();
    expect((await f.admin.from('jobs').insert({ id: otherJob, job_number: `other-${otherJob}`, name: 'Other' })).error).toBeNull();
    for (const [destination, status] of [[jobId, 'skipped_duplicate'], [otherJob, 'job_conflict']] as const) {
      const value = await fresh(first.bytes, destination);
      const input = { ...value.owner, lease_generation: value.lease.lease_generation };
      expect(await ok(claim, input)).toMatchObject({ status: 'duplicate_active', photo_id: first.created.photo_id, job_id: jobId });
      expect(await ok(claim, input)).toMatchObject({ status: 'duplicate_active' });
      const record = await f.admin.from('photo_upload_attempts').select('status,lease_expires_at').eq('id', value.owner.owner_id).single();
      expect(record.data).toEqual({ status, lease_expires_at: null });
      expect((await f.admin.storage.from('photos').info(value.created.original_path)).error).not.toBeNull();
    }
    const request = new Request(`http://localhost:3000/api/photos/exists?job=${otherJob}&sha=${first.input.content_sha256}`);
    expect(await (await withRequest(request, f.employeeA.cookies, () => exists(request))).json()).toMatchObject({ status: 'duplicate_active', job_id: jobId });
  });

  it('renews and releases the exact lease; stale release cannot cancel a replacement owner', async () => {
    const value = await prepared();
    expect(await ok(renew, value.payload)).toHaveProperty('lease_expires_at');
    expect(await ok(release, { ...value.payload, status: 'retryable_failed', error_code: 'upload_failed' })).toBeTruthy();
    const replacement = await ok(acquire, value.owner);
    expect(replacement.lease_generation).toBeGreaterThan(value.lease.lease_generation);
    expect((await call(release, { ...value.payload, status: 'cancelled' })).status).toBe(409);
    expect((await f.admin.from('photo_content_claims').select('*').eq('upload_attempt_id', value.owner.owner_id)).data).toEqual([]);
  });
  it('retries only a failed sidecar on the owning created photo, preserving immutable original finalization', async () => {
    const value = await prepared(); await upload(value);
    value.payload.warnings = ['sidecar_failed', 'metadata_skipped'];
    await ok(finalize, value.payload);
    const before = await f.admin.from('photo_upload_attempts').select('finalize_payload,result').eq('id', value.owner.owner_id).single();
    const sidecar = new TextEncoder().encode('<x:xmpmeta/>');
    const input = { ...value.owner, sidecar_name: 'fixture.xmp', sidecar_bytes: sidecar.length };
    expect((await call(attach, input)).status).toBe(409);
    expect((await f.employeeA.client.storage.from('photos').upload(value.created.sidecar_path, sidecar, { contentType: 'application/rdf+xml' })).error).toBeNull();
    expect((await call(attach, input, f.employeeB)).status).toBe(403);
    expect((await call(attach, { ...input, sidecar_bytes: sidecar.length + 1 })).status).toBe(409);
    expect(await ok(attach, input)).toMatchObject({ status: 'created', photo_id: value.created.photo_id, warnings: ['metadata_skipped'] });
    expect(await ok(attach, input)).toMatchObject({ status: 'created', warnings: ['metadata_skipped'] });
    expect((await f.admin.from('photo_upload_attempts').select('finalize_payload,result').eq('id', value.owner.owner_id).single()).data).toEqual(before.data);
    expect((await f.admin.from('photos').select('original_path,content_sha256,sidecar_path').eq('id', value.created.photo_id).single()).data)
      .toEqual({ original_path: value.created.original_path, content_sha256: value.input.content_sha256, sidecar_path: value.created.sidecar_path });
    await f.sql.query("update public.photos set deleted_at=now(),deleted_by=uploader_id,purge_after=now()+interval '30 days' where id=$1", [value.created.photo_id]);
    expect((await call(attach, input)).status).toBe(409);
    const duplicate = await prepared(); await upload(duplicate); await canonical(duplicate); await ok(finalize, duplicate.payload);
    expect((await call(attach, { ...duplicate.owner, sidecar_name: 'fixture.xmp', sidecar_bytes: sidecar.length })).status).toBe(409);
  });

  it('persists waiting-claim on release without taking the competing owner claim', async () => {
    const first = await fresh(); const second = await fresh(first.bytes);
    const one = { ...first.owner, lease_generation: first.lease.lease_generation };
    const two = { ...second.owner, lease_generation: second.lease.lease_generation };
    expect(await ok(claim, one)).toMatchObject({ status: 'claimed' });
    expect(await ok(claim, two)).toMatchObject({ status: 'waiting_claim' });
    expect(await ok(release, { ...two, status: 'retryable_failed' })).toMatchObject({ status: 'waiting_claim' });
    expect((await f.admin.from('photo_upload_attempts').select('status,lease_expires_at').eq('id', second.owner.owner_id).single()).data)
      .toEqual({ status: 'waiting_claim', lease_expires_at: null });
    expect((await f.admin.from('photo_content_claims').select('upload_attempt_id').eq('content_sha256', first.input.content_sha256).single()).data)
      .toEqual({ upload_attempt_id: first.owner.owner_id });
  });

  it('refreshes unresolved trash after restore and requests fresh identity after canonical purge', async () => {
    const first = await prepared(); await upload(first); await ok(finalize, first.payload);
    await f.sql.query("update photos set deleted_at=now(),deleted_by=uploader_id,purge_after=now()+interval '30 days' where id=$1", [first.created.photo_id]);
    const duplicate = await fresh(first.bytes);
    expect(await ok(claim, { ...duplicate.owner, lease_generation: duplicate.lease.lease_generation }))
      .toMatchObject({ status: 'duplicate_trashed', photo_id: first.created.photo_id });
    expect((await f.admin.from('photo_upload_attempts').select('status,lease_expires_at').eq('id', duplicate.owner.owner_id).single()).data)
      .toEqual({ status: 'restore_required', lease_expires_at: null });
    await f.sql.query('update photos set deleted_at=null,deleted_by=null,purge_after=null where id=$1', [first.created.photo_id]);
    expect(await ok(attempt, duplicate.input)).toMatchObject({ result: { status: 'duplicate_active', photo_id: first.created.photo_id } });
    expect((await f.admin.from('photo_upload_attempts').select('status').eq('id', duplicate.owner.owner_id).single()).data)
      .toEqual({ status: 'skipped_duplicate' });
    await f.sql.query("update photos set deleted_at=now(),deleted_by=uploader_id,purge_after=now()+interval '30 days' where id=$1", [first.created.photo_id]);
    const pending = await fresh(first.bytes);
    const prior = await ok(claim, { ...pending.owner, lease_generation: pending.lease.lease_generation });
    await f.sql.query('delete from photos where id=$1', [first.created.photo_id]);
    expect(await ok(attempt, pending.input)).toMatchObject({ result: { new_attempt_required: true, photo_id: first.created.photo_id } });
    const stored = await f.admin.from('photo_upload_attempts').select('result,lease_expires_at').eq('id', pending.owner.owner_id).single();
    expect(stored.data?.result).toMatchObject({ status: prior.status, photo_id: prior.photo_id });
    expect(stored.data?.result).not.toHaveProperty('new_attempt_required');
    expect(stored.data?.lease_expires_at).toBeNull();
  });

  it('reuses completed original bytes after lease loss and rejects stale, foreign or finalized probes', async () => {
    const value = await prepared();
    expect(await ok(original, value.payload)).toEqual({ complete: false });
    await upload(value);
    const before = await f.admin.storage.from('photos').info(value.created.original_path);
    expect(before.error).toBeNull();
    await ok(release, { ...value.payload, status: 'retryable_failed' });
    const lease = await ok(acquire, value.owner);
    const claimResult = await ok(claim, { ...value.owner, lease_generation: lease.lease_generation });
    expect((await call(original, value.payload)).status).toBe(409);
    const retry = { ...value.payload, lease_generation: lease.lease_generation, claim_generation: claimResult.claim_generation };
    expect((await call(original, retry, f.employeeB)).status).toBe(403);
    expect((await call(original, { ...retry, claim_generation: retry.claim_generation + 1 })).status).toBe(409);
    expect((await call(original, retry, f.employeeA, 'https://attacker.example')).status).toBe(403);
    expect(await ok(original, retry)).toEqual({ complete: true });
    expect(await ok(finalize, retry)).toMatchObject({ status: 'created', photo_id: value.created.photo_id });
    expect((await f.admin.storage.from('photos').info(value.created.original_path)).data).toEqual(before.data);
    expect((await f.admin.from('photos').select('id').eq('content_sha256', value.input.content_sha256)).data)
      .toEqual([{ id: value.created.photo_id }]);
    expect((await call(original, retry)).status).toBe(409);
  });

  it('requires a fresh attempt for wrong original size and fails closed on Storage metadata service errors', async () => {
    const value = await prepared();
    expect((await f.employeeA.client.storage.from('photos').upload(value.created.original_path, new Uint8Array([1]), { contentType: 'image/jpeg' })).error).toBeNull();
    const mismatched = await call(original, value.payload);
    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toMatchObject({ error: { code: 'conflict', retryable: false }, new_attempt_required: true });
    const storageClient = supabaseAdmin.storage;
    vi.spyOn(supabaseAdmin, 'storage', 'get').mockReturnValue(storageClient);
    const from = storageClient.from.bind(storageClient);
    vi.spyOn(storageClient, 'from').mockImplementation(bucket => {
      const client = from(bucket);
      vi.spyOn(client, 'info').mockResolvedValue({ data: null, error: { status: 503, message: 'Isolated unavailable' } } as never);
      return client;
    });
    expect((await call(original, value.payload)).status).toBe(503);
    expect((await f.admin.from('photos').select('id').eq('id', value.created.photo_id)).data).toEqual([]);
  });

});
