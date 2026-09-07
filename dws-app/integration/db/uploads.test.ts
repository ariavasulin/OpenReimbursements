import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

type Owner = { kind: 'ordinary' | 'migration'; id: string; actor: string; photoId: string;
  path: string; jobId: string; digest: string; bytes: Uint8Array; batchId?: string };

describe('upload lease, claim and finalize transactions (AC-4, AC-5)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true, mcp_enabled: true }).eq('singleton', true)).error).toBeNull();
    // The production index is deliberately an operator cutover; this is an
    // isolated, empty-identity fixture that exercises its real unique arbiter.
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const args = (owner: Owner) => ({ p_actor: owner.actor, p_owner_kind: owner.kind, p_owner_id: owner.id });
  async function owner(kind: Owner['kind'], actor: string, bytes = randomBytes(4)): Promise<Owner> {
    const id = randomUUID(); const photoId = randomUUID(); const jobId = randomUUID();
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `upload-${jobId}`, name: 'Upload fixture' })).error).toBeNull();
    if (kind === 'ordinary') {
      const created = await rpc('photo_create_upload_attempt', { p_actor: actor, p_job_id: jobId,
        p_source_signature: `fixture:${id}:4`, p_digest: digest, p_original_name: 'fixture.jpg',
        p_original_bytes: bytes.length, p_mime_type: 'image/jpeg', p_attempt_id: id, p_photo_id: photoId });
      return { kind, id, actor, photoId, jobId, digest, bytes, path: created.original_path };
    }
    const batchId = randomUUID(); const sourceId = randomUUID(); const scanId = randomUUID();
    expect((await f.admin.from('migration_batches').insert({ id: batchId, created_by: actor, origin: 'ui',
      script_name: 'migrate_photos', status: 'draft' })).error).toBeNull();
    expect((await f.admin.from('migration_sources').insert({ id: sourceId, batch_id: batchId, job_id: jobId,
      kind: 'directory', label: 'Isolated source', scan_id: scanId, sealed_scan_id: scanId,
      sealed_fingerprint: digest, sealed_at: new Date().toISOString() })).error).toBeNull();
    const path = `originals/${actor}/${photoId}/fixture.jpg`;
    expect((await f.admin.from('migration_items').insert({ id, source_id: sourceId, relative_path: 'fixture.jpg', revision: 1,
      scan_id: scanId, source_signature: `fixture:${id}:4`, original_name: 'fixture.jpg', original_bytes: bytes.length,
      mime_type: 'image/jpeg', content_sha256: digest, photo_id: photoId, original_path: path,
      thumb_path: `derived/${actor}/${photoId}_thumb.webp`, preview_path: `derived/${actor}/${photoId}_preview.webp`,
      sidecar_path: `originals/${actor}/${photoId}/fixture.xmp` })).error).toBeNull();
    expect((await f.admin.from('migration_batches').update({ status: 'approved', approved_by: actor, approved_at: new Date().toISOString(), approved_rules: {} }).eq('id', batchId)).error).toBeNull();
    return { kind, id, actor, photoId, jobId, digest, bytes, path, batchId };
  }
  async function upload(value: Owner) {
    const actor = value.actor === f.employeeA.id ? f.employeeA : f.employeeB;
    const result = await actor.client.storage.from('photos').upload(value.path, value.bytes, { contentType: 'image/jpeg' });
    expect(result.error).toBeNull();
  }
  async function leased(value: Owner) {
    const lease = await rpc('photo_acquire_upload', args(value));
    const claim = await rpc('photo_claim_content', { ...args(value), p_generation: lease.lease_generation });
    expect(claim.status).toBe('claimed');
    return { ...args(value), p_generation: lease.lease_generation, p_claim_generation: claim.claim_generation, p_photo: { kind: 'image' } };
  }

  it('simultaneous ordinary/migration claims have one owner; takeover fences the old claim and replay preserves the canonical row', async () => {
    const bytes = randomBytes(4);
    const a = await owner('ordinary', f.employeeA.id, bytes);
    const b = await owner('migration', f.employeeB.id, bytes);
    const owners = [a, b];
    const leases = await Promise.all(owners.map(value => rpc('photo_acquire_upload', args(value))));
    const claims = await Promise.all(owners.map((value, i) => rpc('photo_claim_content', { ...args(value), p_generation: leases[i].lease_generation })));
    expect(claims.map(value => value.status).sort()).toEqual(['claimed', 'waiting_claim']);
    const winner = claims.findIndex(value => value.status === 'claimed'); const loser = 1 - winner;
    expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toHaveLength(1);
    await Promise.all(owners.map(upload));
    await f.sql.query("update public.photo_content_claims set lease_expires_at=now()-interval '1 second' where content_sha256=$1", [a.digest]);
    const takeover = await rpc('photo_claim_content', { ...args(owners[loser]), p_generation: leases[loser].lease_generation });
    expect(takeover.claim_generation).toBeGreaterThan(claims[winner].claim_generation);
    const stale = await f.admin.rpc('photo_finalize_upload', { ...args(owners[winner]), p_generation: leases[winner].lease_generation,
      p_claim_generation: claims[winner].claim_generation, p_photo: { kind: 'image' } });
    expect(stale.error?.message).toBe('stale_claim');
    const finalizeArgs = { ...args(owners[loser]), p_generation: leases[loser].lease_generation,
      p_claim_generation: takeover.claim_generation, p_photo: { kind: 'image' } };
    const canonical = await rpc('photo_finalize_upload', finalizeArgs);
    expect(canonical).toEqual({ status: 'created', photo_id: owners[loser].photoId, job_id: owners[loser].jobId });
    expect(await rpc('photo_finalize_upload', finalizeArgs)).toEqual(canonical);
    expect((await f.admin.rpc('photo_finalize_upload', { ...finalizeArgs, p_photo: { kind: 'image', tags: ['changed'] } })).error?.message).toBe('conflict');
    const lookup = await rpc('photo_claim_content', { ...args(owners[winner]), p_generation: leases[winner].lease_generation });
    expect(lookup.status).toBe('duplicate_active');
    expect(lookup.photo_id).toBe(canonical.photo_id);
    expect((await f.admin.from('photos').select('id').eq('content_sha256', a.digest)).data).toEqual([{ id: canonical.photo_id }]);
    expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toEqual([]);
  });

  it('a lease takeover prevents stale finalize/renew and changed source cannot reuse an attempt', async () => {
    const a = await owner('ordinary', f.employeeA.id);
    const first = await leased(a);
    await upload(a);
    expect((await f.admin.rpc('photo_acquire_upload', args(a))).error?.message).toBe('lease_busy');
    await f.sql.query("update public.photo_upload_attempts set lease_expires_at=now()-interval '1 second' where id=$1", [a.id]);
    await f.sql.query("update public.photo_content_claims set lease_expires_at=now()-interval '1 second' where upload_attempt_id=$1", [a.id]);
    const second = await leased(a);
    expect(second.p_generation).toBeGreaterThan(first.p_generation);
    expect((await f.admin.rpc('photo_finalize_upload', first)).error?.message).toBe('stale_lease');
    const { p_photo: _photo, ...renewArgs } = first;
    expect((await f.admin.rpc('photo_renew_upload', renewArgs)).error?.message).toBe('stale_lease');
    expect((await f.admin.rpc('photo_create_upload_attempt', { p_actor: a.actor, p_job_id: a.jobId,
      p_source_signature: 'changed-source', p_digest: a.digest, p_original_name: 'fixture.jpg', p_original_bytes: 4,
      p_mime_type: 'image/jpeg', p_attempt_id: a.id, p_photo_id: a.photoId })).error?.message).toBe('conflict');
    expect((await rpc('photo_finalize_upload', second)).status).toBe('created');
  });

  it('cancel and finalize serialize; cancelled unfinished work never creates a row', async () => {
    const a = await owner('migration', f.employeeA.id);
    const finalizeArgs = await leased(a); await upload(a);
    const [finalized, cancelled] = await Promise.all([
      f.admin.rpc('photo_finalize_upload', finalizeArgs),
      f.admin.rpc('photo_cancel_migration', { p_actor: a.actor, p_batch_id: a.batchId }),
    ]);
    expect(cancelled.error).toBeNull();
    const row = await f.admin.from('photos').select('id').eq('id', a.photoId);
    const item = await f.admin.from('migration_items').select('status').eq('id', a.id).single();
    if (finalized.error) {
      expect(finalized.error.message).toBe('conflict'); expect(row.data).toEqual([]); expect(item.data?.status).toBe('cancelled');
    } else {
      expect(finalized.data.status).toBe('created'); expect(row.data).toEqual([{ id: a.photoId }]); expect(item.data?.status).toBe('completed');
    }
    expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toEqual([]);
    const b = await owner('migration', f.employeeA.id);
    const bArgs = await leased(b); await upload(b);
    await rpc('photo_cancel_migration', { p_actor: b.actor, p_batch_id: b.batchId });
    expect((await f.admin.rpc('photo_finalize_upload', bArgs)).error?.message).toBe('conflict');
    expect((await f.admin.from('photos').select('id').eq('id', b.photoId)).data).toEqual([]);
  });

  it('finalize independently requires original Storage metadata and exact byte count', async () => {
    const a = await owner('ordinary', f.employeeA.id); const finalizeArgs = await leased(a);
    expect((await f.admin.rpc('photo_finalize_upload', finalizeArgs)).error?.message).toBe('original_unverified');
    const wrong = await f.employeeA.client.storage.from('photos').upload(a.path, new Uint8Array([1]), { contentType: 'image/jpeg' });
    expect(wrong.error).toBeNull();
    expect((await f.admin.rpc('photo_finalize_upload', finalizeArgs)).error?.message).toBe('original_unverified');
    expect((await f.admin.from('photos').select('id').eq('id', a.photoId)).data).toEqual([]);
  });

  it('a superseded source revision cannot finalize its old attempt', async () => {
    const a = await owner('migration', f.employeeA.id); const finalizeArgs = await leased(a); await upload(a);
    expect((await f.admin.from('migration_items').update({ is_current: false }).eq('id', a.id)).error).toBeNull();
    expect((await f.admin.rpc('photo_finalize_upload', finalizeArgs)).error?.message).toBe('conflict');
    expect((await f.admin.from('photos').select('id').eq('id', a.photoId)).data).toEqual([]);
  });

  it('a lost final response replays after batch completion or cancellation without new writes', async () => {
    for (const finalStatus of ['completed', 'cancelled']) {
      const a = await owner('migration', f.employeeA.id); const finalizeArgs = await leased(a); await upload(a);
      const outcome = await rpc('photo_finalize_upload', finalizeArgs);
      if (finalStatus === 'completed') {
        expect((await f.admin.from('migration_batches').update({ status: 'completed' }).eq('id', a.batchId!)).error).toBeNull();
      } else {
        await rpc('photo_cancel_migration', { p_actor: a.actor, p_batch_id: a.batchId });
      }
      expect(await rpc('photo_finalize_upload', finalizeArgs)).toEqual(outcome);
      expect((await f.admin.rpc('photo_finalize_upload', { ...finalizeArgs, p_photo: { kind: 'image', tags: ['changed'] } })).error?.message).toBe('conflict');
      expect((await f.admin.from('photos').select('id').eq('id', a.photoId)).data).toEqual([{ id: a.photoId }]);
    }
  });

  async function insertCanonical(value: Owner, trashed = false, otherJob = false) {
    const id = randomUUID(); const now = Date.now();
    const jobId = otherJob ? randomUUID() : value.jobId;
    if (otherJob) expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `canonical-${jobId}`, name: 'Other destination' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeB.id,
      kind: 'image', captured_at: new Date(now).toISOString(), original_path: `originals/${f.employeeB.id}/${id}/canonical.jpg`, content_sha256: value.digest,
      ...(trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id,
        purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) })).error).toBeNull();
    return { id, jobId };
  }
  const table = (value: Owner) => value.kind === 'ordinary' ? 'photo_upload_attempts' : 'migration_items';

  it('late canonical inserts persist same-job, cross-job and trash outcomes for both owners and release leases', async () => {
    for (const kind of ['ordinary', 'migration'] as const) for (const state of ['same', 'other', 'trash']) {
      const a = await owner(kind, f.employeeA.id); const finalizeArgs = await leased(a); await upload(a);
      const canonical = await insertCanonical(a, state === 'trash', state === 'other');
      const result = await rpc('photo_finalize_upload', finalizeArgs);
      expect(result.status).toBe(state === 'trash' ? 'duplicate_trashed' : 'duplicate_active');
      expect(result.photo_id).toBe(canonical.id);
      expect(await rpc('photo_finalize_upload', finalizeArgs)).toEqual(result);
      const ledger = await f.admin.from(table(a)).select('status,result,lease_expires_at').eq('id', a.id).single();
      expect(ledger.data).toEqual({ status: state === 'trash' ? 'restore_required' : state === 'other' ? 'job_conflict' : 'skipped_duplicate', result, lease_expires_at: null });
      expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toEqual([]);
      expect((await f.admin.from('photos').select('id').eq('content_sha256', a.digest)).data).toEqual([{ id: canonical.id }]);
    }
  });

  it('preflight canonical results are durable and replay without a live lease or bytes', async () => {
    for (const kind of ['ordinary', 'migration'] as const) for (const state of ['same', 'other', 'trash']) {
      const a = await owner(kind, f.employeeA.id);
      const lease = await rpc('photo_acquire_upload', args(a));
      const canonical = await insertCanonical(a, state === 'trash', state === 'other');
      const claimArgs = { ...args(a), p_generation: lease.lease_generation };
      const result = await rpc('photo_claim_content', claimArgs);
      expect(result.photo_id).toBe(canonical.id);
      expect(result.status).toBe(state === 'trash' ? 'duplicate_trashed' : 'duplicate_active');
      expect(await rpc('photo_claim_content', { ...claimArgs, p_generation: null })).toEqual(result);
      expect(await rpc('photo_acquire_upload', args(a))).toEqual(result);
      const ledger = await f.admin.from(table(a)).select('status,result,lease_expires_at').eq('id', a.id).single();
      expect(ledger.data).toEqual({ status: state === 'trash' ? 'restore_required' : state === 'other' ? 'job_conflict' : 'skipped_duplicate', result, lease_expires_at: null });
      expect((await f.admin.from(table(a)).update({ status: 'uploading' }).eq('id', a.id)).error?.message).toBe('conflict');
      expect((await f.admin.rpc('photo_claim_content', { ...claimArgs, p_actor: f.employeeB.id })).error?.message).toBe('wrong_consumer');
      expect((await f.sql.query("select name from storage.objects where bucket_id='photos' and name=$1", [a.path])).rows).toEqual([]);
    }
  });

  it('waiting status persists and preflight/release cannot release another owner claim', async () => {
    const bytes = randomBytes(4);
    const a = await owner('ordinary', f.employeeA.id, bytes); const active = await leased(a);
    const b = await owner('migration', f.employeeB.id, bytes); const lease = await rpc('photo_acquire_upload', args(b));
    const claimArgs = { ...args(b), p_generation: lease.lease_generation };
    expect((await rpc('photo_claim_content', claimArgs)).status).toBe('waiting_claim');
    expect((await f.admin.from('migration_items').select('status').eq('id', b.id).single()).data?.status).toBe('waiting_claim');
    expect(await rpc('photo_release_upload', { ...claimArgs, p_status: 'retryable_failed', p_error_code: 'claim_wait' })).toEqual({ status: 'waiting_claim' });
    expect((await f.admin.from('migration_items').select('status,lease_expires_at').eq('id', b.id).single()).data).toEqual({ status: 'waiting_claim', lease_expires_at: null });
    expect((await f.admin.from('photo_content_claims').select('upload_attempt_id').eq('content_sha256', a.digest)).data).toEqual([{ upload_attempt_id: a.id }]);
    const next = await rpc('photo_acquire_upload', args(b)); await insertCanonical(b);
    await rpc('photo_claim_content', { ...args(b), p_generation: next.lease_generation });
    expect((await f.admin.from('photo_content_claims').select('upload_attempt_id').eq('content_sha256', a.digest)).data).toEqual([{ upload_attempt_id: a.id }]);
    await rpc('photo_release_upload', { ...args(a), p_generation: active.p_generation, p_status: 'cancelled' });
    expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toEqual([]);
  });

  it('preflight closes its own previous claim without uploading a second original', async () => {
    for (const kind of ['ordinary', 'migration'] as const) {
      const a = await owner(kind, f.employeeA.id); const lease = await leased(a);
      await insertCanonical(a);
      expect((await rpc('photo_claim_content', { ...args(a), p_generation: lease.p_generation })).status).toBe('duplicate_active');
      expect((await f.admin.from('photo_content_claims').select('*').eq('content_sha256', a.digest)).data).toEqual([]);
    }
  });

  it('ambiguous legacy hashes fail closed without selecting a canonical photo', async () => {
    const a = await owner('ordinary', f.employeeA.id);
    const b = await owner('ordinary', f.employeeA.id);
    const connection = await f.sql.connect();
    try {
      await connection.query('begin');
      await connection.query('drop index public.photos_content_sha256');
      await connection.query(`insert into public.photos(id,job_id,uploader_id,kind,captured_at,original_path,content_sha256)
        values(gen_random_uuid(),$1,$2,'image',now(),'legacy/a.jpg',$3),
              (gen_random_uuid(),$4,$2,'image',now(),'legacy/b.jpg',$3)`, [a.jobId, a.actor, a.digest, b.jobId]);
      await expect(connection.query('select public.photo_canonical_outcome($1)', [a.digest])).rejects.toThrow('conflict');
    } finally {
      await connection.query('rollback');
      connection.release();
    }
  });

  it('release fences stale workers, supports unchanged retry, and preserves a committed result', async () => {
    for (const kind of ['ordinary', 'migration'] as const) {
      const a = await owner(kind, f.employeeA.id); const first = await leased(a);
      await rpc('photo_release_upload', { ...args(a), p_generation: first.p_generation, p_status: 'retryable_failed', p_error_code: 'transfer_failed' });
      const second = await leased(a);
      expect(second.p_generation).toBeGreaterThan(first.p_generation);
      expect((await f.admin.rpc('photo_release_upload', { ...args(a), p_generation: first.p_generation, p_status: 'cancelled' })).error?.message).toBe('stale_lease');
      await upload(a); const result = await rpc('photo_finalize_upload', second);
      expect(await rpc('photo_release_upload', { ...args(a), p_generation: first.p_generation, p_status: 'cancelled' })).toEqual(result);
      expect((await f.admin.from(table(a)).select('status').eq('id', a.id).single()).data?.status).toBe('completed');
      expect(await rpc('photo_upload_cleanup_paths', args(a))).toEqual([]);
    }
  });

  it('unresolved duplicates refresh after a confirmed move or restore without transferring bytes', async () => {
    for (const kind of ['ordinary', 'migration'] as const) for (const trashed of [false, true]) {
      const a = await owner(kind, f.employeeA.id); const lease = await rpc('photo_acquire_upload', args(a));
      const canonical = await insertCanonical(a, trashed, true);
      const first = await rpc('photo_claim_content', { ...args(a), p_generation: lease.lease_generation });
      expect(first.job_id).toBe(canonical.jobId);
      expect((await f.admin.from('photos').update({ job_id: a.jobId, deleted_at: null, deleted_by: null, purge_after: null }).eq('id', canonical.id)).error).toBeNull();
      const refreshed = kind === 'ordinary'
        ? (await rpc('photo_create_upload_attempt', { p_actor: a.actor, p_job_id: a.jobId,
          p_source_signature: `fixture:${a.id}:4`, p_digest: a.digest, p_original_name: 'fixture.jpg', p_original_bytes: 4,
          p_mime_type: 'image/jpeg', p_attempt_id: a.id, p_photo_id: a.photoId })).result
        : await rpc('photo_claim_content', { ...args(a), p_generation: null });
      expect(refreshed).toMatchObject({ status: 'duplicate_active', photo_id: canonical.id, job_id: a.jobId });
      expect((await f.admin.from(table(a)).select('status,lease_expires_at').eq('id', a.id).single()).data).toEqual({ status: 'skipped_duplicate', lease_expires_at: null });
    }
  });

  it('a removed canonical requires a new attempt without reopening cleaned paths', async () => {
    const a = await owner('ordinary', f.employeeA.id); const lease = await rpc('photo_acquire_upload', args(a));
    const canonical = await insertCanonical(a, true);
    const result = await rpc('photo_claim_content', { ...args(a), p_generation: lease.lease_generation });
    expect((await f.admin.from('photos').delete().eq('id', canonical.id)).error).toBeNull();
    expect(await rpc('photo_acquire_upload', args(a))).toEqual({ ...result, new_attempt_required: true });
    const retry = await rpc('photo_create_upload_attempt', { p_actor: a.actor, p_job_id: a.jobId,
      p_source_signature: `fixture:${a.id}:4`, p_digest: a.digest, p_original_name: 'fixture.jpg', p_original_bytes: 4,
      p_mime_type: 'image/jpeg', p_attempt_id: a.id, p_photo_id: a.photoId });
    expect(retry.result).toEqual({ ...result, new_attempt_required: true });
    expect((await f.admin.from('photo_upload_attempts').select('result,status,lease_expires_at').eq('id', a.id).single()).data)
      .toEqual({ result, status: 'restore_required', lease_expires_at: null });
  });

  it('sidecar retry attaches only to its unchanged created original and preserves finalization replay', async () => {
    for (const kind of ['ordinary', 'migration'] as const) {
      const a = await owner(kind, f.employeeA.id); const finalArgs = await leased(a); await upload(a);
      finalArgs.p_photo = { kind: 'image', warnings: ['sidecar_missing', 'sidecar_metadata_failed', 'preview_missing'] } as typeof finalArgs.p_photo;
      const result = await rpc('photo_finalize_upload', finalArgs);
      const attachArgs = { ...args(a), p_sidecar_name: 'fixture.xmp', p_sidecar_bytes: 3 };
      expect((await f.admin.rpc('photo_attach_upload_sidecar', attachArgs)).error?.message).toBe('sidecar_unverified');
      const path = `originals/${a.actor}/${a.photoId}/fixture.xmp`;
      expect((await f.employeeA.client.storage.from('photos').upload(path, new Uint8Array([1, 2, 3]), { contentType: 'application/rdf+xml' })).error).toBeNull();
      expect((await f.admin.rpc('photo_attach_upload_sidecar', { ...attachArgs, p_sidecar_bytes: 4 })).error?.message).toBe('sidecar_unverified');
      expect(await rpc('photo_attach_upload_sidecar', attachArgs)).toEqual({ ...result, warnings: ['sidecar_metadata_failed', 'preview_missing'] });
      expect(await rpc('photo_attach_upload_sidecar', attachArgs)).toEqual({ ...result, warnings: ['sidecar_metadata_failed', 'preview_missing'] });
      expect((await f.admin.from('photos').select('sidecar_path,sidecar_name,upload_warnings').eq('id', a.photoId).single()).data)
        .toEqual({ sidecar_path: path, sidecar_name: 'fixture.xmp', upload_warnings: ['sidecar_metadata_failed', 'preview_missing'] });
      expect((await f.admin.from(table(a)).select('warnings,finalize_payload').eq('id', a.id).single()).data)
        .toEqual({ warnings: ['sidecar_metadata_failed', 'preview_missing'], finalize_payload: finalArgs.p_photo });
      expect(await rpc('photo_finalize_upload', finalArgs)).toEqual(result);
      expect((await f.admin.rpc('photo_attach_upload_sidecar', { ...attachArgs, p_actor: f.employeeB.id })).error?.message).toBe('wrong_consumer');
      const other = await owner(kind, f.employeeA.id);
      expect((await f.admin.from('photos').update({ job_id: other.jobId }).eq('id', a.photoId)).error).toBeNull();
      expect((await f.admin.rpc('photo_attach_upload_sidecar', attachArgs)).error?.message).toBe('conflict');
    }
    const duplicate = await owner('ordinary', f.employeeA.id); const lease = await rpc('photo_acquire_upload', args(duplicate));
    await insertCanonical(duplicate); await rpc('photo_claim_content', { ...args(duplicate), p_generation: lease.lease_generation });
    expect((await f.admin.rpc('photo_attach_upload_sidecar', { ...args(duplicate), p_sidecar_name: 'fixture.xmp', p_sidecar_bytes: 3 })).error?.message).toBe('conflict');
  });

  it('sidecar repair cannot alias and overwrite the committed original path', async () => {
    const seed = await owner('ordinary', f.employeeA.id); const id = randomUUID(); const photoId = randomUUID();
    const created = await rpc('photo_create_upload_attempt', { p_actor: seed.actor, p_job_id: seed.jobId,
      p_source_signature: `fixture:${id}:4`, p_digest: seed.digest, p_original_name: 'fixture.xmp', p_original_bytes: 4,
      p_mime_type: 'application/rdf+xml', p_attempt_id: id, p_photo_id: photoId });
    const value = { ...seed, id, photoId, path: created.original_path };
    const finalArgs = await leased(value); await upload(value); await rpc('photo_finalize_upload', finalArgs);
    expect(created.original_path).toBe(created.sidecar_path);
    expect((await f.admin.rpc('photo_attach_upload_sidecar', { ...args(value), p_sidecar_name: 'fixture.xmp', p_sidecar_bytes: 4 })).error?.message).toBe('conflict');
  });

  it('cleanup exposes only committed duplicate deterministic paths and protects every photo reference', async () => {
    for (const kind of ['ordinary', 'migration'] as const) {
      const a = await owner(kind, f.employeeA.id); const finalArgs = await leased(a); await upload(a);
      expect(await rpc('photo_upload_cleanup_paths', args(a))).toEqual([]);
      const canonical = await insertCanonical(a); const result = await rpc('photo_finalize_upload', finalArgs);
      const paths = await rpc('photo_upload_cleanup_paths', args(a)) as string[];
      expect(paths.sort()).toEqual([a.path, `derived/${a.actor}/${a.photoId}_thumb.webp`,
        `derived/${a.actor}/${a.photoId}_preview.webp`, `originals/${a.actor}/${a.photoId}/fixture.xmp`].sort());
      for (const column of ['original_path', 'thumb_path', 'preview_path', 'sidecar_path', 'playback_path']) {
        expect((await f.admin.from('photos').update({ [column]: a.path }).eq('id', canonical.id)).error).toBeNull();
        expect(await rpc('photo_upload_cleanup_paths', args(a))).not.toContain(a.path);
        expect((await f.admin.from('photos').update({ [column]: column === 'original_path' ? `originals/${f.employeeB.id}/${canonical.id}/canonical.jpg` : null }).eq('id', canonical.id)).error).toBeNull();
      }
      expect((await f.admin.rpc('photo_upload_cleanup_paths', { ...args(a), p_actor: f.employeeB.id })).error?.message).toBe('wrong_consumer');
      expect((await f.employeeA.client.rpc('photo_upload_cleanup_paths', args(a))).error).not.toBeNull();
      expect((await f.admin.from(table(a)).update({ lease_expires_at: new Date(Date.now() + 120_000).toISOString() }).eq('id', a.id)).error?.message).toBe('conflict');
      expect(await rpc('photo_finalize_upload', finalArgs)).toEqual(result);
    }
  });

  it('cleanup preserves unfinished ordinary and migration references and UUIDs cannot cross ledgers', async () => {
    const a = await owner('ordinary', f.employeeA.id); const finalArgs = await leased(a); await upload(a);
    await insertCanonical(a); await rpc('photo_finalize_upload', finalArgs);
    const b = await owner('migration', f.employeeA.id);
    expect((await f.admin.from('migration_items').update({ thumb_path: a.path }).eq('id', b.id)).error).toBeNull();
    expect(await rpc('photo_upload_cleanup_paths', args(a))).not.toContain(a.path);
    expect((await f.admin.from('migration_items').update({ thumb_path: null }).eq('id', b.id)).error).toBeNull();
    const ordinary = await f.admin.from('photo_upload_attempts').select('*').eq('id', a.id).single();
    expect(ordinary.error).toBeNull();
    expect((await f.admin.from('photo_upload_attempts').insert({ ...ordinary.data, id: randomUUID(), photo_id: randomUUID(),
      result: null, finalize_payload: null, status: 'pending' })).error).toBeNull();
    expect(await rpc('photo_upload_cleanup_paths', args(a))).toEqual([]);
    expect((await f.admin.rpc('photo_create_upload_attempt', { p_actor: b.actor, p_job_id: b.jobId,
      p_source_signature: 'uuid-collision', p_digest: b.digest, p_original_name: 'fixture.jpg', p_original_bytes: 4,
      p_mime_type: 'image/jpeg', p_attempt_id: randomUUID(), p_photo_id: b.photoId })).error?.message).toBe('conflict');
  });
});
