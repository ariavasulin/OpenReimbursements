import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { withRequest } from './request-context';
import type { BeginUploadOutcome, FinalizeUploadInput } from '@/lib/photos/upload-contract';

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
import { POST as begin } from '@/app/api/photo-migrations/uploads/begin/route';
import { POST as attempt } from '@/app/api/photo-migrations/uploads/attempt/route';
import { POST as release } from '@/app/api/photo-migrations/uploads/release/route';
import { POST as finalize } from '@/app/api/photos/route';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';

// UP-1: one request runs attempt, lease, claim and (on a retry) the original
// check, with the same SQL in the same order as the separate routes.
describe('POST /api/photo-migrations/uploads/begin with real Auth, SQL and Storage', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `routes-begin-${jobId}`, name: 'Begin route' })).error).toBeNull();
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
  });
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); });

  async function call(handler: (r: Request) => Promise<Response>, body: unknown, actor = f.employeeA, origin = 'http://localhost:3000') {
    const request = new Request('http://localhost:3000/api/photo-migrations/uploads/begin', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return withRequest(request, actor.cookies, () => handler(request));
  }
  async function ok<T = BeginUploadOutcome>(handler: (r: Request) => Promise<Response>, body: unknown): Promise<T> {
    const response = await call(handler, body); const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200); return result as T;
  }
  function input(bytes = randomBytes(8)) {
    const id = randomUUID();
    return { bytes, body: { attempt_id: id, photo_id: id, job_id: jobId, album_ids: [], source_signature: `begin:${id}`,
      content_sha256: createHash('sha256').update(bytes).digest('hex'), original_name: 'fixture.jpg',
      original_bytes: bytes.length, mime_type: 'image/jpeg', probe: false } };
  }
  const lease = (begun: BeginUploadOutcome) => {
    if (begun.acquired?.status !== 'acquired') throw new Error('no lease');
    return { owner_kind: begun.attempt.owner_kind, owner_id: begun.attempt.owner_id, lease_generation: begun.acquired.lease_generation };
  };
  const store = (path: string, bytes: Uint8Array) => f.employeeA.client.storage.from('photos').upload(path, bytes, { contentType: 'image/jpeg', upsert: true });

  it('creates, leases and claims in one call, skips the original check when fresh, and finalizes', async () => {
    const { bytes, body } = input();
    const begun = await ok(begin, body);
    expect(begun.attempt).toMatchObject({ owner_kind: 'ordinary', owner_id: body.attempt_id, photo_id: body.photo_id, result: null });
    expect(begun.acquired).toMatchObject({ status: 'acquired' });
    expect(begun.claimed).toMatchObject({ status: 'claimed' });
    expect(begun.original).toBeNull();
    expect((await store(begun.attempt.original_path, bytes)).error).toBeNull();
    const claimed = begun.claimed as { claim_generation: number };
    const payload: FinalizeUploadInput = { ...lease(begun), claim_generation: claimed.claim_generation,
      id: body.photo_id, job_id: jobId, kind: 'image', tags: [], captured_at: null, captured_at_source: 'upload',
      original_path: begun.attempt.original_path, original_bytes: bytes.length, mime_type: 'image/jpeg', original_name: 'fixture.jpg',
      thumb_path: begun.attempt.thumb_path, preview_path: null, duration_secs: null, sidecar_path: null, sidecar_name: null,
      content_sha256: body.content_sha256, warnings: [] };
    // The missing thumbnail is found while the original is checked, and becomes a warning.
    const finalized = await ok<{ status: string; warnings: string[] }>(finalize, payload);
    expect(finalized).toMatchObject({ status: 'created', warnings: ['Thumbnail upload failed; the original is preserved.'] });
    // A replay of the same begin reports the committed photo without a lease.
    const replay = await ok(begin, body);
    expect(replay.attempt.result).toMatchObject({ status: 'created', photo_id: body.photo_id });
    expect(replay.acquired).toBeUndefined();
  });

  it('on a retry finds a complete original, and flags one of the wrong size', async () => {
    const complete = input();
    const first = await ok(begin, complete.body);
    expect((await store(first.attempt.original_path, complete.bytes)).error).toBeNull();
    await ok(release, { ...lease(first), status: 'retryable_failed' });
    const retried = await ok(begin, { ...complete.body, probe: true });
    expect(retried.original).toEqual({ complete: true });
    expect(lease(retried).lease_generation).toBe(lease(first).lease_generation + 1);

    const wrong = input();
    const started = await ok(begin, wrong.body);
    expect((await store(started.attempt.original_path, randomBytes(3))).error).toBeNull();
    await ok(release, { ...lease(started), status: 'retryable_failed' });
    const mismatched = await ok(begin, { ...wrong.body, probe: true });
    expect(mismatched.original_mismatch).toBe(true);
    // The browser releases the lease it was given, as with the separate routes.
    await ok(release, { ...lease(mismatched), status: 'retryable_failed' });
  });

  it('reports existing bytes as a duplicate at the claim, with no lease left to release', async () => {
    const { bytes, body } = input();
    const id = randomUUID(); const path = `originals/${f.employeeB.id}/${id}/canonical.jpg`;
    expect((await f.employeeB.client.storage.from('photos').upload(path, bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeB.id, kind: 'image', captured_at: new Date().toISOString(),
      original_path: path, original_bytes: bytes.length, content_sha256: body.content_sha256 })).error).toBeNull();
    const begun = await ok(begin, body);
    expect(begun.claimed).toMatchObject({ status: 'duplicate_active', photo_id: id });
    expect(begun.original).toBeUndefined();
  });

  it('releases the lease itself when a later step fails, so the automatic retry can take a new one', async () => {
    const { body } = input();
    const rpc = supabaseAdmin.rpc.bind(supabaseAdmin);
    const spy = vi.spyOn(supabaseAdmin, 'rpc').mockImplementation(((name: string, args: Record<string, unknown>) =>
      name === 'photo_claim_content' ? Promise.resolve({ data: null, error: { message: 'connection reset' } }) : rpc(name, args)) as never);
    const failed = await call(begin, body);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.retryable).toBe(true);
    spy.mockRestore();
    expect((await f.admin.from('photo_upload_attempts').select('lease_expires_at').eq('id', body.attempt_id).single()).data)
      .toEqual({ lease_expires_at: null });
    const retried = await ok(begin, body);
    expect(retried.claimed).toMatchObject({ status: 'claimed' });
  });

  // UP-3: a dropped connection loses the browser's release, so the lease stays live for two minutes.
  it('hands back the lease a lost release left, and reports a live one as a wait rather than a conflict', async () => {
    const { body } = input();
    const first = await ok(begin, body);
    const held = lease(first).lease_generation;
    const busy = await ok(begin, { ...body, probe: true });
    expect(busy.acquired).toBeUndefined();
    expect(busy.lease_busy!.retry_after_ms).toBeGreaterThan(60_000);
    expect(busy.lease_busy!.retry_after_ms).toBeLessThanOrEqual(120_000);
    const resumed = await ok(begin, { ...body, probe: true, release_generation: held });
    expect(resumed.claimed).toMatchObject({ status: 'claimed' });
    expect(lease(resumed).lease_generation).toBe(held + 1);
    // An old generation hands nothing back: the live lease is someone else's now.
    const stale = await ok(begin, { ...body, probe: true, release_generation: held });
    expect(stale.lease_busy).toBeDefined();
    expect((await call(begin, { ...body, release_generation: 'one' })).status).toBe(400);
    await ok(release, { ...lease(resumed), status: 'retryable_failed' });
  });

  it('keeps the same refusals as the separate routes', async () => {
    const { body } = input();
    expect((await call(begin, body, f.employeeA, 'https://attacker.example')).status).toBe(403);
    const anonymous = new Request('http://localhost:3000/api/photo-migrations/uploads/begin', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(body) });
    expect((await withRequest(anonymous, [], () => begin(anonymous))).status).toBe(401);
    expect((await call(begin, { ...body, job_id: null, album_ids: [] })).status).toBe(400);
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: false }).eq('singleton', true)).error).toBeNull();
    expect((await call(begin, body)).status).toBe(503);
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true }).eq('singleton', true)).error).toBeNull();
    await ok(begin, body);
    // Another employee cannot take over this attempt: refused at the attempt
    // step, exactly as the separate attempt route refuses it, before any lease.
    const stolen = await call(begin, body, f.employeeB);
    expect(stolen.status).toBe((await call(attempt, body, f.employeeB)).status);
    expect(stolen.status).toBe(409);
  });
});
