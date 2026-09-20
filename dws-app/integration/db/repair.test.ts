import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

describe('repair lease, retention and Storage deletion fences (AC-9, AC-10)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  let holder: string; let generation: number; let jobId: string;
  beforeAll(async () => {
    f = await createFixtures(); jobId = randomUUID();
    await f.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [jobId, `repair-${jobId}`, 'Repair database fixture']);
    await f.sql.query('update public.photo_release_state set repair_enabled=true,photo_writes_enabled=true');
  });
  afterAll(async () => { await f?.close(); });
  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull(); return data;
  }
  const lease = () => ({ p_holder: holder, p_generation: generation });
  beforeEach(async () => {
    await f.sql.query("update public.photo_repair_progress set lease_expires_at=clock_timestamp()-interval '1 second'");
    holder = randomUUID(); generation = (await rpc('photo_repair_acquire', { p_holder: holder })).lease_generation;
  });
  async function photo(expiryDays: number | null = null, original?: string, duplicateOf?: string) {
    const id = randomUUID(); const path = original ?? `originals/${f.employeeA.id}/${id}/fixture.jpg`;
    await f.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,captured_at,original_path,
      deleted_at,deleted_by,purge_after,duplicate_of,legacy_content_sha256)
      values($1,$2,$3,'image',clock_timestamp(),$4,
        case when $5::int is not null then date_trunc('milliseconds',statement_timestamp())+($5-30)*interval '1 day' end,
        case when $5::int is not null then $3::uuid end,
        case when $5::int is not null then date_trunc('milliseconds',statement_timestamp())+$5*interval '1 day' end,$6,
        case when $6::uuid is not null then repeat('e',64) end)`, [id, jobId, f.employeeA.id, path, expiryDays, duplicateOf ?? null]);
    return { id, path };
  }
  const authorize = (path: string, photoId?: string) => rpc('photo_repair_authorize_delete', { ...lease(), p_path: path, p_photo_id: photoId ?? null });
  async function storage(path: string) {
    expect((await f.admin.storage.from('photos').upload(path, new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })).error).toBeNull();
  }
  async function remove(path: string) { expect((await f.admin.storage.from('photos').remove([path])).error).toBeNull(); }

  it('one live owner wins, renew preserves cursors, and process-death takeover fences stale checkpoints and deletes', async () => {
    await f.sql.query("update public.photo_repair_progress set lease_expires_at=clock_timestamp()-interval '1 second'");
    const contenders = [randomUUID(), randomUUID()];
    const results = await Promise.all(contenders.map(p_holder => rpc('photo_repair_acquire', { p_holder })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.findIndex(Boolean); holder = contenders[winner]; generation = results[winner].lease_generation;
    expect(await rpc('photo_repair_acquire', { p_holder: randomUUID() })).toBeNull();
    const cursor = { after: randomUUID() }; const storageCursor = { after: 'originals/checkpoint' };
    await rpc('photo_repair_checkpoint', { ...lease(), p_photo_cursor: cursor, p_storage_cursor: storageCursor });
    expect(await rpc('photo_repair_renew', lease())).toBe(true);
    const old = lease();
    await f.sql.query("update public.photo_repair_progress set lease_expires_at=clock_timestamp()-interval '1 second'");
    holder = randomUUID();
    const resumed = await rpc('photo_repair_acquire', { p_holder: holder }); generation = resumed.lease_generation;
    expect(generation).toBeGreaterThan(old.p_generation);
    expect(resumed).toMatchObject({ photo_cursor: cursor, storage_cursor: storageCursor, inventory_complete: false });
    for (const [name, args] of [
      ['photo_repair_renew', old],
      ['photo_repair_checkpoint', { ...old, p_photo_cursor: null, p_storage_cursor: null }],
      ['photo_repair_authorize_delete', { ...old, p_path: 'originals/stale' }],
    ] as const) expect((await f.admin.rpc(name, args)).error?.message).toBe('stale_lease');
    await rpc('photo_repair_checkpoint', { ...lease(), p_photo_cursor: cursor, p_storage_cursor: storageCursor, p_release: true });
    expect((await f.admin.rpc('photo_repair_renew', lease())).error?.message).toBe('stale_lease');
  });

  it('claims only expired rows; partial path deletion and a dead process preserve row and retention until retry', async () => {
    const retained = await photo(1); const due = await photo(-1); const preview = `derived/${f.employeeA.id}/${due.id}_preview.webp`;
    await f.sql.query('update public.photos set preview_path=$2 where id=$1', [due.id, preview]);
    await storage(due.path); await storage(preview);
    const before = (await f.sql.query('select deleted_at::text,purge_after::text from public.photos where id=$1', [due.id])).rows[0];
    const claimed = await rpc('photo_repair_claim_purge', { ...lease(), p_limit: 500 });
    expect(claimed.some((p: { id: string }) => p.id === due.id)).toBe(true);
    expect(claimed.some((p: { id: string }) => p.id === retained.id)).toBe(false);
    expect(await authorize(retained.path, retained.id)).toBe(false);
    expect(await authorize(due.path, due.id)).toBe(true); await remove(due.path);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: due.id })).toBe(false);
    await f.sql.query("update public.photo_repair_progress set lease_expires_at=clock_timestamp()-interval '1 second'");
    holder = randomUUID(); generation = (await rpc('photo_repair_acquire', { p_holder: holder })).lease_generation;
    expect((await rpc('photo_repair_claim_purge', lease())).some((p: { id: string }) => p.id === due.id)).toBe(true);
    expect((await f.sql.query('select deleted_at::text,purge_after::text from public.photos where id=$1', [due.id])).rows[0]).toEqual(before);
    expect(await authorize(due.path, due.id)).toBe(true); await remove(due.path);
    expect(await authorize(preview, due.id)).toBe(true); await remove(preview);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: due.id })).toBe(true);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: due.id })).toBe(false);
  });

  it('shared retained objects survive and duplicate references prevent canonical claiming until aliases are purged', async () => {
    const canonical = await photo(-2); const alias = await photo(-1, canonical.path, canonical.id);
    await storage(canonical.path);
    const claims = await rpc('photo_repair_claim_purge', lease());
    expect(claims.some((p: { id: string }) => p.id === canonical.id)).toBe(false);
    expect(claims.some((p: { id: string }) => p.id === alias.id)).toBe(true);
    expect(await authorize(alias.path, alias.id)).toBe(false);
    // Approved action history retains exact IDs without blocking physical purge.
    const batch = randomUUID();
    await f.sql.query("insert into public.photo_action_batches(id,created_by,origin,action) values($1,$2,'ordinary','trash')", [batch, f.employeeA.id]);
    await f.sql.query('insert into public.photo_action_items(batch_id,photo_id,expected_job_id) values($1,$2,$3)', [batch, alias.id, jobId]);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: alias.id })).toBe(true);
    expect((await f.sql.query('select photo_id from public.photo_action_items where batch_id=$1', [batch])).rows[0].photo_id).toBe(alias.id);
    expect((await rpc('photo_repair_claim_purge', lease())).some((p: { id: string }) => p.id === canonical.id)).toBe(true);
    await expect(photo(1, undefined, canonical.id)).rejects.toThrow('conflict');
    expect(await authorize(canonical.path, canonical.id)).toBe(true); await remove(canonical.path);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: canonical.id })).toBe(true);
  });

  it('protects inferred derivative destinations and all explicit retained references', async () => {
    const active = await photo(); const retained = await photo(1);
    for (const p of [active, retained]) {
      for (const suffix of ['thumb.webp', 'preview.webp', 'playback.mp4']) {
        expect(await authorize(`derived/${f.employeeA.id}/${p.id}_${suffix}`)).toBe(false);
      }
      expect(await authorize(p.path)).toBe(false);
    }
  });

  it('durable authorization serializes with new owner creation and permanently rejects the retired path', async () => {
    const id = randomUUID(); const path = `originals/${f.employeeA.id}/${id}/fixture.jpg`;
    const locker = await f.sql.connect(); const creator = await f.sql.connect();
    let pending: Promise<Error | null> | undefined;
    try {
      await locker.query('begin');
      expect((await locker.query('select public.photo_repair_authorize_delete($1,$2,$3)', [holder, generation, path])).rows[0].photo_repair_authorize_delete).toBe(true);
      const pid = (await creator.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = creator.query(`select public.photo_create_upload_attempt($1,$2,$3,$4,'fixture.jpg',3,'image/jpeg',$5,$6)`,
        [f.employeeA.id, jobId, id, createHash('sha256').update(id).digest('hex'), randomUUID(), id]).then(() => null, error => error as Error);
      await expect.poll(async () => (await f.sql.query("select wait_event_type='Lock' as blocked from pg_stat_activity where pid=$1", [pid])).rows[0]?.blocked).toBe(true);
      await locker.query('commit');
      expect((await pending)?.message).toBe('path_retired');
      expect(await authorize(path)).toBe(true);
      expect((await f.sql.query('select path from public.photo_repair_deleted_paths where path=$1', [path])).rows).toHaveLength(1);
    } finally { await locker.query('rollback'); await pending; locker.release(); creator.release(); }
  });

  it('an unfinished expired attempt remains resumable while concurrent orphan/finalize safely preserves its bytes', async () => {
    const id = randomUUID(); const photoId = randomUUID(); const bytes = new Uint8Array([1, 2, 3]);
    const attempt = await rpc('photo_create_upload_attempt', { p_actor: f.employeeA.id, p_job_id: jobId,
      p_source_signature: id, p_digest: createHash('sha256').update(bytes).digest('hex'), p_original_name: 'fixture.jpg',
      p_original_bytes: 3, p_mime_type: 'image/jpeg', p_attempt_id: id, p_photo_id: photoId });
    const owner = { p_actor: f.employeeA.id, p_owner_kind: 'ordinary', p_owner_id: id };
    await storage(attempt.original_path);
    await f.sql.query("update public.photo_upload_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
    expect(await authorize(attempt.original_path)).toBe(false);
    const acquired = await rpc('photo_acquire_upload', owner);
    const claim = await rpc('photo_claim_content', { ...owner, p_generation: acquired.lease_generation });
    const [deleted, finalized] = await Promise.all([
      authorize(attempt.original_path),
      rpc('photo_finalize_upload', { ...owner, p_generation: acquired.lease_generation, p_claim_generation: claim.claim_generation, p_photo: { kind: 'image' } }),
    ]);
    expect(deleted).toBe(false); expect(finalized.status).toBe('created');
    expect(await authorize(attempt.sidecar_path)).toBe(false);
    expect((await f.sql.query("select name from storage.objects where bucket_id='photos' and name=$1", [attempt.original_path])).rows).toHaveLength(1);
  });

  it('restore wins before expiry under a row lock and purge cannot claim the restored row', async () => {
    const p = await photo(1); const batch = randomUUID();
    await f.sql.query("insert into public.photo_action_batches(id,created_by,origin,action) values($1,$2,'ordinary','restore')", [batch, f.employeeA.id]);
    await rpc('photo_materialize_action', { p_actor: f.employeeA.id, p_batch_id: batch, p_cursor: null, p_ids: [p.id], p_next_cursor: null, p_complete: true });
    await rpc('photo_approve_action', { p_actor: f.employeeA.id, p_batch_id: batch });
    const [restored, claimed] = await Promise.all([
      rpc('photo_apply_action', { p_actor: f.employeeA.id, p_batch_id: batch, p_photo_id: p.id }),
      rpc('photo_repair_claim_purge', lease()),
    ]);
    expect(restored.status).toBe('applied'); expect(claimed.some((row: { id: string }) => row.id === p.id)).toBe(false);
    expect(await authorize(p.path, p.id)).toBe(false);
  });

  it('cancel fences an ordinary lease and makes its abandoned paths eligible for cleanup', async () => {
    const id = randomUUID(); const photoId = randomUUID();
    const attempt = await rpc('photo_create_upload_attempt', { p_actor: f.employeeA.id, p_job_id: jobId,
      p_source_signature: id, p_digest: createHash('sha256').update(id).digest('hex'), p_original_name: 'cancel.jpg',
      p_original_bytes: 3, p_mime_type: 'image/jpeg', p_attempt_id: id, p_photo_id: photoId });
    const owner = { p_actor: f.employeeA.id, p_owner_kind: 'ordinary', p_owner_id: id };
    const acquired = await rpc('photo_acquire_upload', owner);
    await rpc('photo_claim_content', { ...owner, p_generation: acquired.lease_generation });
    expect((await f.admin.rpc('photo_cancel_upload', { p_actor: f.employeeB.id, p_attempt_id: id })).error?.message).toBe('forbidden');
    expect(await rpc('photo_cancel_upload', { p_actor: f.employeeA.id, p_attempt_id: id })).toEqual({ status: 'cancelled' });
    expect(await rpc('photo_cancel_upload', { p_actor: f.employeeA.id, p_attempt_id: id })).toEqual({ status: 'cancelled' });
    expect((await f.admin.rpc('photo_acquire_upload', owner)).error?.message).toBe('conflict');
    expect((await f.admin.rpc('photo_release_upload', { ...owner, p_generation: acquired.lease_generation, p_status: 'retryable_failed' })).error?.message).toBe('conflict');
    expect((await f.sql.query('select lease_generation,lease_expires_at from public.photo_upload_attempts where id=$1', [id])).rows[0])
      .toMatchObject({ lease_generation: String(acquired.lease_generation + 1), lease_expires_at: null });
    expect((await f.sql.query('select * from public.photo_content_claims where upload_attempt_id=$1', [id])).rows).toHaveLength(0);
    expect(await authorize(attempt.original_path)).toBe(true);
    expect((await rpc('photo_create_upload_attempt', { p_actor: f.employeeA.id, p_job_id: jobId,
      p_source_signature: id, p_digest: createHash('sha256').update(id).digest('hex'), p_original_name: 'cancel.jpg',
      p_original_bytes: 3, p_mime_type: 'image/jpeg', p_attempt_id: id, p_photo_id: photoId })).status).toBe('cancelled');
  });

  it('caps claims and Storage pages, keyset resume is exclusive, and session clients cannot use repair authority', async () => {
    for (const name of ['photo_repair_claim_purge', 'photo_repair_storage_page']) {
      expect((await f.admin.rpc(name, { ...lease(), p_limit: 501 })).error?.message).toBe('invalid_input');
      expect((await f.employeeA.client.rpc(name, lease())).error).not.toBeNull();
    }
    const prefix = `originals/${f.employeeA.id}/${randomUUID()}`;
    await storage(`${prefix}/a.jpg`); await storage(`${prefix}/b.jpg`);
    const page = await rpc('photo_repair_storage_page', { ...lease(), p_after: `${prefix}/`, p_limit: 1 });
    expect(page.map((row: { name: string }) => row.name)).toEqual([`${prefix}/a.jpg`]);
    expect((await rpc('photo_repair_storage_page', { ...lease(), p_after: page[0].name, p_limit: 1 }))[0].name).toBe(`${prefix}/b.jpg`);
    const backlog = await rpc('photo_repair_backlog', lease());
    expect(backlog).toHaveProperty('purge_backlog'); expect(backlog).toHaveProperty('oldest_due_at');
  });

  it('a purged legacy UUID cannot be reused by a different filename, uploader, or direct photo insert', async () => {
    const legacy = await photo(-1);
    await rpc('photo_repair_claim_purge', lease());
    expect(await authorize(legacy.path, legacy.id)).toBe(true);
    expect(await rpc('photo_repair_finish_purge', { ...lease(), p_photo_id: legacy.id })).toBe(true);
    expect((await f.sql.query('select id from public.photo_repair_retired_ids where id=$1', [legacy.id])).rows).toHaveLength(1);
    expect((await f.admin.rpc('photo_create_upload_attempt', { p_actor: f.employeeB.id, p_job_id: jobId,
      p_source_signature: randomUUID(), p_digest: createHash('sha256').update(legacy.id).digest('hex'), p_original_name: 'different.jpg',
      p_original_bytes: 3, p_mime_type: 'image/jpeg', p_attempt_id: randomUUID(), p_photo_id: legacy.id })).error?.message).toBe('conflict');
    const batch = randomUUID(); const source = randomUUID();
    await f.sql.query("insert into public.migration_batches(id,created_by,origin,script_name) values($1,$2,'ui','migrate_photos')", [batch, f.employeeB.id]);
    await f.sql.query("insert into public.migration_sources(id,batch_id,job_id,kind,label) values($1,$2,$3,'files','Retired UUID fixture')", [source, batch, jobId]);
    await expect(f.sql.query(`insert into public.migration_items(source_id,relative_path,revision,scan_id,source_signature,original_name,original_bytes,mime_type,photo_id)
      values($1,'different.jpg',1,$2,'retired-id','different.jpg',3,'image/jpeg',$3)`, [source, randomUUID(), legacy.id])).rejects.toThrow('conflict');
    await expect(f.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,captured_at,original_path)
      values($1,$2,$3,'image',clock_timestamp(),$4)`, [legacy.id, jobId, f.employeeB.id, `originals/${f.employeeB.id}/${legacy.id}/different.jpg`])).rejects.toThrow('conflict');
  });

  it('dead-row removal rechecks the exact original and excludes retained trash and canonical references', async () => {
    const active = await photo(); const retained = await photo(1); const canonical = await photo(); await photo(1, undefined, canonical.id);
    const drop = (p: { id: string; path: string }) => rpc('photo_repair_delete_dead', { ...lease(), p_photo_id: p.id, p_expected_original: p.path });
    expect(await drop(retained)).toBe(false); expect(await drop(canonical)).toBe(false);
    await storage(active.path); expect(await drop(active)).toBe(false); await remove(active.path);
    expect(await rpc('photo_repair_delete_dead', { ...lease(), p_photo_id: active.id, p_expected_original: 'changed' })).toBe(false);
    expect(await drop(active)).toBe(true);
  });
});
