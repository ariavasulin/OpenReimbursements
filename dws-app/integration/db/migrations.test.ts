import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';
import type { SourceMetadata } from '../../src/lib/photos/migration/inventory';

type Entry = SourceMetadata & { status: string; warnings: string[]; sidecar: null };
type Item = Entry & { id: string; source_id: string; revision: number; photo_id: string; upload_attempt_id: string;
  original_path: string | null; content_sha256: string | null; is_current: boolean; result: unknown; lease_generation: number };

describe('durable migration inventory and recovery (AC-3, AC-4, AC-6)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  let jobs: string[];
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true, mcp_enabled: true }).eq('singleton', true)).error).toBeNull();
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
    jobs = [];
    for (const number of ['3612', '4170']) {
      const { data, error } = await f.admin.from('jobs').upsert({ job_number: number, name: `Migration ${number}`, is_active: true }, { onConflict: 'job_number' }).select('id').single();
      expect(error).toBeNull(); jobs.push(data!.id);
    }
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, { p_actor: f.employeeA.id, ...args });
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  async function denied(name: string, args: Record<string, unknown>, message = 'conflict') {
    expect((await f.admin.rpc(name, { p_actor: f.employeeA.id, ...args })).error?.message).toBe(message);
  }
  const entry = (path = 'site.jpg', mtime = 1, bytes = 4): Entry => ({ relative_path: path,
    original_name: path.split('/').at(-1)!, original_bytes: bytes, source_mtime: mtime,
    source_signature: `${path}:${bytes}:${mtime}`, mime_type: 'image/jpeg', status: 'pending', warnings: [], sidecar: null });
  const action = (batch: string, p_action: string) => rpc('migration_batch_action', { p_batch: batch, p_action });
  const owner = (item: Item) => ({ p_owner_kind: 'migration', p_owner_id: item.id });
  async function batch(script = 'migrate_photos') { return (await rpc('migration_create_batch', { p_script: script })).id as string; }
  async function source(batchId: string, job = jobs[0], kind = 'directory') {
    return rpc('migration_source', { p_batch: batchId, p_source: randomUUID(), p_job: job, p_kind: kind,
      p_label: `Isolated ${kind}`, p_rules: { exclude_picasa: true } });
  }
  async function scan(sourceId: string) {
    const id = randomUUID(); await rpc('migration_scan', { p_source: sourceId, p_scan: id }); return id;
  }
  function chunkArgs(sourceId: string, scanId: string, entries: Entry[], number = 0) {
    const payload = JSON.stringify(entries);
    return { p_source: sourceId, p_scan: scanId, p_number: number, p_entries: entries,
      p_digest: createHash('sha256').update(payload).digest('hex'), p_encoded: Buffer.byteLength(payload) };
  }
  async function sealArgs(sourceId: string, scanId: string, chunks: number) {
    const staged = await f.admin.from('migration_inventory_chunks').select('payload_digest,entry_count,total_bytes').eq('source_id', sourceId).eq('scan_id', scanId).order('chunk_number');
    const source = await f.admin.from('migration_sources').select('job_id').eq('id', sourceId).single();
    expect(staged.error).toBeNull(); expect(source.error).toBeNull();
    return { p_source: sourceId, p_scan: scanId, p_chunks: chunks, p_job: source.data!.job_id,
      p_entries: staged.data!.reduce((n, c) => n + c.entry_count, 0),
      p_bytes: staged.data!.reduce((n, c) => n + Number(c.total_bytes), 0),
      p_fingerprint: createHash('sha256').update(staged.data!.map(c => c.payload_digest).join('')).digest('hex') };
  }
  async function seal(sourceId: string, entries: Entry[]) {
    const scanId = await scan(sourceId);
    await rpc('migration_chunk', chunkArgs(sourceId, scanId, entries));
    await rpc('migration_seal', await sealArgs(sourceId, scanId, 1));
    return scanId;
  }
  async function items(sourceId: string): Promise<Item[]> {
    const { data, error } = await f.admin.from('migration_items').select('*').eq('source_id', sourceId).order('relative_path').order('revision');
    expect(error).toBeNull(); return data as Item[];
  }
  async function prepared(item: Item, bytes = randomBytes(item.original_bytes)) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const value = await rpc('migration_prepare', { p_item: item.id, p_revision: item.revision, p_signature: item.source_signature, p_digest: digest });
    return { item: value as Item, bytes, digest };
  }
  async function leased(item: Item) {
    const lease = await rpc('photo_acquire_upload', owner(item));
    const claim = await rpc('photo_claim_content', { ...owner(item), p_generation: lease.lease_generation });
    expect(claim.status).toBe('claimed');
    return { ...owner(item), p_generation: lease.lease_generation, p_claim_generation: claim.claim_generation, p_photo: { kind: 'image' } };
  }
  async function commit(item: Item) {
    const ready = await prepared(item); const args = await leased(ready.item);
    expect((await f.employeeA.client.storage.from('photos').upload(ready.item.original_path!, ready.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    const result = await rpc('photo_finalize_upload', args);
    expect(result.status).toBe('created');
    return { ...ready, args, result };
  }

  it('keeps equal filenames in distinct approved source/job mappings', async () => {
    const id = await batch(); const a = await source(id, jobs[0]); const b = await source(id, jobs[1]);
    await seal(a.id, [entry()]); await seal(b.id, [entry()]);
    const approved = await action(id, 'approve'); await action(id, 'resume');
    expect(approved.approved_rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: a.id, job_id: jobs[0] }), expect.objectContaining({ source_id: b.id, job_id: jobs[1] }),
    ]));
    const first = await commit((await items(a.id))[0]); const second = await commit((await items(b.id))[0]);
    expect(first.item.id).not.toBe(second.item.id); expect(first.item.photo_id).not.toBe(second.item.photo_id);
    const photos = await f.admin.from('photos').select('id,job_id').in('id', [first.item.photo_id, second.item.photo_id]);
    expect(photos.data).toEqual(expect.arrayContaining([{ id: first.item.photo_id, job_id: jobs[0] }, { id: second.item.photo_id, job_id: jobs[1] }]));
    expect((await action(id, 'complete')).status).toBe('completed');
    await denied('migration_source', { p_batch: id, p_source: a.id, p_job: jobs[1], p_kind: 'directory', p_label: a.label, p_rules: {} });
  });

  it('replays identical chunks, rejects changed payloads and gaps, and only publishes a contiguous seal', async () => {
    const id = await batch(); const s = await source(id); const scanId = await scan(s.id);
    const zero = chunkArgs(s.id, scanId, [entry('a.jpg')]);
    expect((await rpc('migration_chunk', zero)).replayed).toBe(false);
    expect((await rpc('migration_chunk', zero)).replayed).toBe(true);
    await denied('migration_chunk', { ...zero, p_digest: 'f'.repeat(64) });
    await denied('migration_chunk', { ...zero, p_entries: [entry('different.jpg')] });
    await rpc('migration_chunk', chunkArgs(s.id, scanId, [entry('c.jpg')], 2));
    await denied('migration_seal', await sealArgs(s.id, scanId, 3));
    await denied('migration_seal', await sealArgs(s.id, scanId, 2));
    expect(await items(s.id)).toEqual([]);
    await denied('migration_batch_action', { p_batch: id, p_action: 'approve' });
    await rpc('migration_chunk', chunkArgs(s.id, scanId, [entry('b.jpg')], 1));
    const sealed = await rpc('migration_seal', await sealArgs(s.id, scanId, 3));
    expect((await items(s.id)).map(i => i.relative_path)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(await rpc('migration_seal', await sealArgs(s.id, scanId, 3))).toEqual(sealed);
    expect((await rpc('migration_chunk', zero)).replayed).toBe(true);
    await denied('migration_chunk', chunkArgs(s.id, scanId, [entry('late.jpg')], 3));
  });

  it('rolls back the entire seal on an invalid entry and rejects duplicate paths across chunks', async () => {
    const id = await batch(); const s = await source(id); const initial = entry('original.jpg'); await seal(s.id, [initial]);
    const before = await items(s.id); const scanId = await scan(s.id);
    await rpc('migration_chunk', chunkArgs(s.id, scanId, [entry('new.jpg'), { ...entry('invalid.jpg'), status: 'not_a_status' }]));
    expect((await f.admin.rpc('migration_seal', { p_actor: f.employeeA.id, ...await sealArgs(s.id, scanId, 1) })).error).not.toBeNull();
    expect(await items(s.id)).toEqual(before);
    const duplicateScan = await scan(s.id);
    await rpc('migration_chunk', chunkArgs(s.id, duplicateScan, [initial]));
    await rpc('migration_chunk', chunkArgs(s.id, duplicateScan, [initial], 1));
    await denied('migration_seal', await sealArgs(s.id, duplicateScan, 2));
    expect(await items(s.id)).toEqual(before);
  });

  it('requires every scan to seal before approval and enforces one source for compact add', async () => {
    const id = await batch(); await denied('migration_batch_action', { p_batch: id, p_action: 'approve' });
    const a = await source(id); const b = await source(id, jobs[1]); await seal(a.id, [entry()]);
    await denied('migration_batch_action', { p_batch: id, p_action: 'approve' });
    await seal(b.id, []); expect((await action(id, 'approve')).status).toBe('approved');
    const compact = await batch('add_photos');
    await denied('migration_source', { p_batch: compact, p_source: randomUUID(), p_job: jobs[0], p_kind: 'directory', p_label: 'Wrong kind', p_rules: {} });
    await source(compact, jobs[0], 'files');
    await denied('migration_source', { p_batch: compact, p_source: randomUUID(), p_job: jobs[1], p_kind: 'files', p_label: 'Second source', p_rules: {} });
  });

  it('rescans a completed batch under the same approval and retains completed history with fresh changed identities', async () => {
    const id = await batch(); const s = await source(id);
    await seal(s.id, [entry('changed.jpg'), entry('absent.jpg')]);
    const approval = await action(id, 'approve'); await action(id, 'resume');
    const original = await items(s.id); const completed = await Promise.all(original.map(commit));
    await action(id, 'complete');
    const nextScan = await scan(s.id);
    const interrupted = await f.admin.from('migration_batches').select('status,approved_at,approved_rules').eq('id', id).single();
    expect(interrupted.data).toEqual({ status: 'interrupted', approved_at: approval.approved_at, approved_rules: approval.approved_rules });
    await rpc('migration_chunk', chunkArgs(s.id, nextScan, [entry('changed.jpg', 2), entry('new.jpg')]));
    expect((await items(s.id)).map(i => i.id)).toEqual(original.map(i => i.id));
    await denied('migration_batch_action', { p_batch: id, p_action: 'resume' });
    await rpc('migration_seal', await sealArgs(s.id, nextScan, 1));
    const after = await items(s.id); const history = after.find(i => i.relative_path === 'changed.jpg' && i.revision === 1)!;
    const changed = after.find(i => i.relative_path === 'changed.jpg' && i.is_current)!;
    expect(history).toMatchObject({ status: 'completed', is_current: false, result: completed.find(c => c.item.id === history.id)!.result });
    expect(changed).toMatchObject({ revision: 2, status: 'pending', result: null });
    expect(changed.id).not.toBe(history.id); expect(changed.upload_attempt_id).not.toBe(history.upload_attempt_id); expect(changed.photo_id).not.toBe(history.photo_id);
    expect(after.find(i => i.relative_path === 'absent.jpg')).toMatchObject({ status: 'completed', is_current: true });
    const resumed = await action(id, 'resume');
    expect(resumed).toMatchObject({ status: 'running', approved_at: approval.approved_at, approved_rules: approval.approved_rules });
    const ready = await prepared(changed); expect(ready.item.original_path).not.toBe(history.original_path);
    expect((await f.admin.from('photos').select('id').in('id', original.map(i => i.photo_id))).data).toHaveLength(2);
    expect(await rpc('migration_counts', { p_batch: id })).toMatchObject({ total: 3, xmp: 0, by_status: { completed: 1, pending: 2 } });
    await denied('migration_batch_action', { p_batch: id, p_action: 'complete' });
  });

  it('fences partial approved rescans, skips missing unfinished files, and preserves unchanged retry identities', async () => {
    const id = await batch(); const s = await source(id); await seal(s.id, [entry('keep.jpg'), entry('missing.jpg')]);
    await action(id, 'approve'); await action(id, 'resume');
    const original = await items(s.id); const keep = await prepared(original[0]); const lease = await leased(keep.item);
    await denied('migration_scan', { p_source: s.id, p_scan: randomUUID() }, 'lease_busy');
    await action(id, 'pause');
    const scanId = await scan(s.id); await rpc('migration_chunk', chunkArgs(s.id, scanId, [entry('keep.jpg'), entry('new.jpg')]));
    expect((await items(s.id)).map(i => i.id)).toEqual(original.map(i => i.id));
    await denied('photo_acquire_upload', owner(keep.item));
    await denied('photo_finalize_upload', lease);
    expect((await f.admin.from('photo_content_claims').select('content_sha256').eq('content_sha256', keep.digest)).data).toEqual([]);
    await denied('migration_batch_action', { p_batch: id, p_action: 'resume' });
    await rpc('migration_seal', await sealArgs(s.id, scanId, 1)); await action(id, 'resume');
    const after = await items(s.id); const unchanged = after.find(i => i.relative_path === 'keep.jpg')!;
    expect(unchanged).toMatchObject({ id: keep.item.id, photo_id: keep.item.photo_id, upload_attempt_id: keep.item.upload_attempt_id, original_path: keep.item.original_path });
    expect(after.find(i => i.relative_path === 'missing.jpg')!.status).toBe('skipped_missing');
    await denied('photo_acquire_upload', owner(after.find(i => i.relative_path === 'missing.jpg')!));
    expect(after.find(i => i.relative_path === 'new.jpg')!.status).toBe('pending');
    const current = await leased(unchanged); expect(current.p_generation).toBeGreaterThan(lease.p_generation);
    await denied('photo_finalize_upload', lease, 'stale_lease');
  });

  it('binds prepare to actor/revision/signature/digest and prevents a second page from taking a live lease', async () => {
    const id = await batch(); const s = await source(id); await seal(s.id, [entry()]); await action(id, 'approve');
    const item = (await items(s.id))[0]; const ready = await prepared(item);
    const base = { p_item: item.id, p_revision: item.revision, p_signature: item.source_signature, p_digest: ready.digest };
    expect(await rpc('migration_prepare', base)).toMatchObject({ photo_id: ready.item.photo_id, original_path: ready.item.original_path });
    await denied('migration_prepare', { ...base, p_revision: 2 });
    await denied('migration_prepare', { ...base, p_signature: 'changed' });
    await denied('migration_prepare', { ...base, p_digest: 'f'.repeat(64) }, 'source_changed');
    await denied('migration_prepare', { ...base, p_actor: f.employeeB.id }, 'wrong_consumer');
    const results = await Promise.all([0, 1].map(() => f.admin.rpc('photo_acquire_upload', { p_actor: f.employeeA.id, ...owner(item) })));
    expect(results.filter(r => !r.error)).toHaveLength(1); expect(results.find(r => r.error)?.error?.message).toBe('lease_busy');
    await denied('photo_acquire_upload', { ...owner(item), p_actor: f.employeeB.id }, 'wrong_consumer');
    expect((await f.employeeA.client.rpc('migration_prepare', { p_actor: f.employeeA.id, ...base })).error).not.toBeNull();
  });

  it('cancellation is terminal, releases claims and preserves only already committed photos', async () => {
    const id = await batch(); const s = await source(id); await seal(s.id, [entry('a.jpg'), entry('b.jpg')]); await action(id, 'approve'); await action(id, 'resume');
    const initial = await items(s.id); const committed = await commit(initial[0]);
    const pending = await prepared(initial[1]); const finalize = await leased(pending.item);
    expect((await f.employeeA.client.storage.from('photos').upload(pending.item.original_path!, pending.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    expect((await action(id, 'cancel')).status).toBe('cancelled');
    expect((await action(id, 'cancel')).status).toBe('cancelled');
    await denied('photo_finalize_upload', finalize);
    await denied('photo_acquire_upload', owner(pending.item));
    await denied('photo_claim_content', { ...owner(pending.item), p_generation: finalize.p_generation });
    await denied('migration_scan', { p_source: s.id, p_scan: randomUUID() });
    for (const p_action of ['resume', 'approve', 'complete', 'pause']) await denied('migration_batch_action', { p_batch: id, p_action });
    expect((await f.admin.from('photo_content_claims').select('*').eq('migration_item_id', pending.item.id)).data).toEqual([]);
    expect((await f.admin.from('photos').select('id').in('id', initial.map(i => i.photo_id))).data).toEqual([{ id: committed.item.photo_id }]);
    expect(await rpc('photo_finalize_upload', committed.args)).toEqual(committed.result);
  });

  it('requires the reviewed seal totals, job and fingerprint to match before publishing inventory', async () => {
    const id = await batch(); const s = await source(id); const scanId = await scan(s.id);
    await rpc('migration_chunk', chunkArgs(s.id, scanId, [entry()]));
    const valid = await sealArgs(s.id, scanId, 1);
    for (const wrong of [{ p_entries: 2 }, { p_bytes: 5 }, { p_job: jobs[1] }, { p_fingerprint: 'f'.repeat(64) }]) {
      await denied('migration_seal', { ...valid, ...wrong });
      expect(await items(s.id)).toEqual([]);
    }
    await rpc('migration_seal', valid); expect(await items(s.id)).toHaveLength(1);
  });

  it('creates a fresh revision to recover an occupied wrong-size path without overwriting old bytes', async () => {
    const id = await batch(); const s = await source(id); await seal(s.id, [entry()]); await action(id, 'approve');
    const ready = await prepared((await items(s.id))[0]); const args = await leased(ready.item);
    expect((await f.employeeA.client.storage.from('photos').upload(ready.item.original_path!, new Uint8Array([1]), { contentType: 'image/jpeg' })).error).toBeNull();
    await denied('photo_finalize_upload', args, 'original_unverified');
    await rpc('photo_release_upload', { ...owner(ready.item), p_generation: args.p_generation, p_status: 'retryable_failed', p_error_code: 'original_path_occupied' });
    const fresh = await rpc('migration_item_action', { p_item: ready.item.id, p_action: 'retry', p_fresh: true }) as Item;
    expect(fresh).toMatchObject({ revision: 2, is_current: true, status: 'pending', result: null });
    expect(fresh.id).not.toBe(ready.item.id); expect(fresh.photo_id).not.toBe(ready.item.photo_id);
    expect(fresh.upload_attempt_id).not.toBe(ready.item.upload_attempt_id);
    const retry = await prepared(fresh, ready.bytes);
    expect(retry.item.original_path).not.toBe(ready.item.original_path);
    await denied('photo_finalize_upload', args);
    const retryArgs = await leased(retry.item);
    expect((await f.employeeA.client.storage.from('photos').upload(retry.item.original_path!, retry.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    expect(await rpc('photo_finalize_upload', retryArgs)).toMatchObject({ status: 'created', photo_id: fresh.photo_id });
    expect((await f.sql.query("select (metadata->>'size')::integer as size from storage.objects where bucket_id='photos' and name=$1", [ready.item.original_path])).rows).toEqual([{ size: 1 }]);
    expect((await items(s.id)).find(i => i.id === ready.item.id)).toMatchObject({ is_current: false, status: 'retryable_failed' });
    expect((await f.admin.from('photo_content_claims').select('*').eq('migration_item_id', ready.item.id)).data).toEqual([]);
  });

  it('serializes concurrent ordinary/migration UUID reservations in both commit orders', async () => {
    for (const first of ['ordinary', 'migration'] as const) {
      const id = await batch(); const s = await source(id); const scanId = await scan(s.id);
      const photoId = randomUUID(); const holder = await f.sql.connect(); const contender = await f.sql.connect();
      const ordinary = { text: 'select public.photo_create_upload_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        values: [f.employeeA.id, jobs[0], `collision:${photoId}`, createHash('sha256').update(photoId).digest('hex'), 'collision.jpg', 4, 'image/jpeg', randomUUID(), photoId] };
      const migration = { text: `insert into public.migration_items(source_id,relative_path,revision,scan_id,source_signature,original_name,original_bytes,mime_type,photo_id)
        values($1,'collision.jpg',1,$2,$3,'collision.jpg',4,'image/jpeg',$4)`, values: [s.id, scanId, `collision:${photoId}`, photoId] };
      try {
        await holder.query('begin'); await contender.query('begin');
        const holderPid = (await holder.query('select pg_backend_pid() pid')).rows[0].pid;
        const contenderPid = (await contender.query('select pg_backend_pid() pid')).rows[0].pid;
        await holder.query(first === 'ordinary' ? ordinary : migration);
        const competing = contender.query(first === 'ordinary' ? migration : ordinary)
          .then(() => null, (error: Error) => error);
        await expect.poll(async () => (await f.sql.query('select pg_blocking_pids($1) blockers', [contenderPid])).rows[0].blockers,
          { timeout: 5000, interval: 10 }).toContain(holderPid);
        await holder.query('commit');
        expect((await competing)?.message).toBe('conflict');
        await contender.query('rollback');
        const reservations = await f.sql.query(`select 'ordinary' owner from public.photo_upload_attempts where photo_id=$1
          union all select 'migration' owner from public.migration_items where photo_id=$1`, [photoId]);
        expect(reservations.rows).toEqual([{ owner: first }]);
      } finally {
        // Release the holder first so a failed blocking assertion cannot strand the contender.
        await holder.query('rollback'); await contender.query('rollback');
        holder.release(); contender.release();
      }
    }
  });

  it('atomically seals 100,000 metadata entries while an ordinary upload waits on UUID reservation', async () => {
    const id = await batch(); const s = await source(id); const scanId = await scan(s.id);
    const totalEntries = 100_000; const fileBytes = 2 * 1024 * 1024;
    // Generate descriptors inside isolated Postgres: no source bytes or full JS corpus.
    await f.sql.query(`with chunks as (
      select (n-1)/500 chunk_number, jsonb_agg(jsonb_build_object(
        'relative_path','large/'||n||'.jpg','original_name',n||'.jpg','original_bytes',$3::bigint,
        'source_mtime',1,'source_signature',n||':'||$3::text||':1','mime_type','image/jpeg',
        'status','pending','warnings','[]'::jsonb,'sidecar',null) order by n) entries
      from generate_series(1,$4::integer) n group by (n-1)/500
    ) insert into public.migration_inventory_chunks(source_id,scan_id,chunk_number,payload_digest,entry_count,encoded_bytes,total_bytes,entries)
      select $1,$2,chunk_number,encode(extensions.digest(entries::text,'sha256'),'hex'),
        jsonb_array_length(entries),octet_length(entries::text),jsonb_array_length(entries)*$3::bigint,entries from chunks`,
    [s.id, scanId, fileBytes, totalEntries]);
    const staged = await f.sql.query(`select count(*)::integer chunks,max(entry_count) max_entries,max(encoded_bytes) max_encoded_bytes,
      sum(entry_count)::integer entries,sum(total_bytes)::text bytes from public.migration_inventory_chunks where source_id=$1`, [s.id]);
    expect(staged.rows[0]).toMatchObject({ chunks: 200, max_entries: 500, entries: totalEntries, bytes: String(totalEntries * fileBytes) });
    expect(staged.rows[0].max_encoded_bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(totalEntries * fileBytes).toBeGreaterThan(100_000_000_000);
    const expected = await sealArgs(s.id, scanId, 200);
    const sealer = await f.sql.connect(); const ordinary = await f.sql.connect();
    let sealMs = 0; let ordinaryMs = 0;
    try {
      await sealer.query('begin');
      await sealer.query("set local statement_timeout='8s'");
      const sealerPid = (await sealer.query('select pg_backend_pid() pid')).rows[0].pid;
      const ordinaryPid = (await ordinary.query('select pg_backend_pid() pid')).rows[0].pid;
      const sealStarted = performance.now();
      const sealing = sealer.query('select public.migration_seal($1,$2,$3,$4,$5,$6,$7,$8)',
        [f.employeeA.id, s.id, scanId, 200, expected.p_entries, expected.p_bytes, jobs[0], expected.p_fingerprint])
        .then(result => { sealMs = performance.now() - sealStarted; return { result, error: null }; },
          (error: Error) => ({ result: null, error }));
      // The insert's real reservation lock remains held through transaction commit.
      await expect.poll(async () => (await f.sql.query("select count(*)::integer n from pg_locks where pid=$1 and locktype='advisory' and granted", [sealerPid])).rows[0].n,
        { timeout: 8000, interval: 10 }).toBeGreaterThan(0);
      const photoId = randomUUID(); const ordinaryStarted = performance.now();
      const creating = ordinary.query('select public.photo_create_upload_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
        [f.employeeA.id, jobs[0], `during-seal:${photoId}`, createHash('sha256').update(photoId).digest('hex'), 'ordinary.jpg', 4, 'image/jpeg', randomUUID(), photoId])
        .then(result => { ordinaryMs = performance.now() - ordinaryStarted; return { result, error: null }; },
          (error: Error) => ({ result: null, error }));
      await expect.poll(async () => (await f.sql.query('select pg_blocking_pids($1) blockers', [ordinaryPid])).rows[0].blockers,
        { timeout: 5000, interval: 10 }).toContain(sealerPid);
      expect((await sealing).error).toBeNull();
      await sealer.query('commit');
      const created = await creating; expect(created.error).toBeNull();
      expect(created.result!.rows[0].result.photo_id).toBe(photoId);
      const current = await f.sql.query(`select count(*)::integer total,count(distinct photo_id)::integer photos,
        count(*) filter(where is_current and status='pending')::integer pending from public.migration_items where source_id=$1`, [s.id]);
      expect(current.rows[0]).toEqual({ total: totalEntries, photos: totalEntries, pending: totalEntries });
      expect((await f.admin.from('migration_sources').select('sealed_scan_id').eq('id', s.id).single()).data?.sealed_scan_id).toBe(scanId);
      console.info('MIGRATION_100K_SEAL_BENCHMARK', JSON.stringify({ entries: totalEntries, total_bytes: totalEntries * fileBytes,
        chunks: 200, max_chunk_bytes: staged.rows[0].max_encoded_bytes, seal_ms: Math.round(sealMs),
        ordinary_ms: Math.round(ordinaryMs), ordinary_blocked_by_seal: true,
        measurement: 'Explicit seal transaction commits immediately after observing the ordinary reservation wait; timings include this coordination.' }));
    } finally {
      await sealer.query('rollback');
      sealer.release(); ordinary.release();
    }
  });
});
