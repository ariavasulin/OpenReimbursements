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
      mime_type: 'image/jpeg', content_sha256: digest, photo_id: photoId, original_path: path })).error).toBeNull();
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

  it('a late canonical insert returns the reserved active/trash outcome without another photo', async () => {
    for (const trashed of [false, true]) {
      const a = await owner('ordinary', f.employeeA.id); const finalizeArgs = await leased(a); await upload(a);
      const canonicalId = randomUUID(); const now = Date.now();
      expect((await f.admin.from('photos').insert({ id: canonicalId, job_id: a.jobId, uploader_id: f.employeeB.id,
        kind: 'image', captured_at: new Date(now).toISOString(), original_path: `originals/${f.employeeB.id}/${canonicalId}/canonical.jpg`, content_sha256: a.digest,
        ...(trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id,
          purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) })).error).toBeNull();
      const result = await rpc('photo_finalize_upload', finalizeArgs);
      expect(result.status).toBe(trashed ? 'duplicate_trashed' : 'duplicate_active');
      expect(result.photo_id).toBe(canonicalId);
      expect(await rpc('photo_finalize_upload', finalizeArgs)).toEqual(result);
      expect((await f.admin.from('photos').select('id').eq('content_sha256', a.digest)).data).toEqual([{ id: canonicalId }]);
    }
  });
});
