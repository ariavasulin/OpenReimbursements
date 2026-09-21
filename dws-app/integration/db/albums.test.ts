import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// plans/active/photo-albums/plan.md, Phase 3: AC-6, AC-7, AC-8 and the database
// halves of AC-9 and AC-10. Every scenario owns its rows.
type Attempt = { id: string; actor: string; photoId: string; path: string; jobId: string | null;
  albumIds: string[]; digest: string; bytes: Uint8Array };

describe('optional project, albums, and bulk tagging (photo-albums AC-6 to AC-10)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true,repair_enabled=true');
    // Premise P2: one photo per content hash. Production builds this index at
    // cutover; the isolated database starts without it.
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) => (await f.admin.rpc(name, args)).error?.message;
  async function job() {
    const id = randomUUID();
    expect((await f.admin.from('jobs').insert({ id, job_number: `albums-${id}`, name: 'Albums fixture' })).error).toBeNull();
    return id;
  }
  const album = async (name = 'Album fixture', actor = f.employeeA.id) =>
    (await rpc('photo_create_album', { p_actor: actor, p_name: name })).album.id as string;
  /** A photo row written directly, as the existing suites do. `jobId: null` is a photo with no project. */
  async function photo(options: { jobId?: string | null; digest?: string; trashed?: boolean; tags?: string[] } = {}) {
    const id = randomUUID(); const now = Date.now();
    const inserted = await f.admin.from('photos').insert({ id, job_id: options.jobId === undefined ? await job() : options.jobId,
      uploader_id: f.employeeB.id, kind: 'image', captured_at: new Date(now).toISOString(), tags: options.tags ?? [],
      original_path: `originals/${f.employeeB.id}/${id}/fixture.jpg`, thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`,
      content_sha256: options.digest ?? null,
      ...(options.trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id,
        purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    return id;
  }
  const members = async (photoId: string) =>
    (await f.sql.query('select album_id from public.album_photos where photo_id=$1 order by album_id', [photoId])).rows.map(row => row.album_id as string);
  const projectOf = async (photoId: string) =>
    (await f.sql.query('select job_id from public.photos where id=$1', [photoId])).rows[0]?.job_id as string | null | undefined;
  const copies = async (digest: string) =>
    (await f.sql.query('select count(*)::int as n from public.photos where content_sha256=$1', [digest])).rows[0].n as number;

  const owner = (a: Attempt) => ({ p_actor: a.actor, p_owner_kind: 'ordinary', p_owner_id: a.id });
  const createArgs = (a: Attempt) => ({ p_actor: a.actor, p_job_id: a.jobId, p_source_signature: `fixture:${a.id}:4`,
    p_digest: a.digest, p_original_name: 'fixture.jpg', p_original_bytes: a.bytes.length, p_mime_type: 'image/jpeg',
    p_attempt_id: a.id, p_photo_id: a.photoId, p_album_ids: a.albumIds });
  function draft(jobId: string | null, albumIds: string[], bytes: Uint8Array = randomBytes(8)): Attempt {
    const id = randomUUID(); const photoId = randomUUID(); const actor = f.employeeA.id;
    return { id, actor, photoId, jobId, albumIds, bytes, digest: createHash('sha256').update(bytes).digest('hex'),
      path: `originals/${actor}/${photoId}/fixture.jpg` };
  }
  async function attempt(jobId: string | null, albumIds: string[], bytes?: Uint8Array) {
    const a = draft(jobId, albumIds, bytes);
    expect((await rpc('photo_create_upload_attempt', createArgs(a))).original_path).toBe(a.path);
    return a;
  }
  async function claim(a: Attempt) {
    const lease = await rpc('photo_acquire_upload', owner(a));
    const claimed = await rpc('photo_claim_content', { ...owner(a), p_generation: lease.lease_generation });
    return { lease, claimed };
  }
  async function store(a: Attempt) {
    expect((await f.employeeA.client.storage.from('photos').upload(a.path, a.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
  }
  const finalizeArgs = (a: Attempt, lease: { lease_generation: number }, claimed: { claim_generation: number }) =>
    ({ ...owner(a), p_generation: lease.lease_generation, p_claim_generation: claimed.claim_generation, p_photo: { kind: 'image' } });
  const ledger = async (a: Attempt) =>
    (await f.admin.from('photo_upload_attempts').select('status,result,job_id,album_ids').eq('id', a.id).single()).data!;

  describe('AC-6: every upload names a project, an album, or both', () => {
    it('refuses an attempt that names neither, and one naming a missing or deleted album', async () => {
      expect(await refused('photo_create_upload_attempt', createArgs(draft(null, [])))).toBe('invalid_input');
      expect(await refused('photo_create_upload_attempt', createArgs(draft(null, [randomUUID()])))).toBe('invalid_input');
      const gone = await album('Deleted before upload');
      await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: gone });
      expect(await refused('photo_create_upload_attempt', createArgs(draft(await job(), [gone])))).toBe('invalid_input');
      // A project that is not active is still refused, as before.
      expect(await refused('photo_create_upload_attempt', createArgs(draft(randomUUID(), [await album()])))).toBe('invalid_input');
    });

    it('finalize independently refuses an attempt that names neither', async () => {
      // Only a direct ledger write can produce this row: create refuses it above.
      const a = draft(null, []);
      expect((await f.admin.from('photo_upload_attempts').insert({ id: a.id, actor_id: a.actor, job_id: null,
        source_signature: `fixture:${a.id}:4`, content_sha256: a.digest, photo_id: a.photoId, original_name: 'fixture.jpg',
        original_bytes: a.bytes.length, mime_type: 'image/jpeg', original_path: a.path,
        thumb_path: `derived/${a.actor}/${a.photoId}_thumb.webp`, preview_path: `derived/${a.actor}/${a.photoId}_preview.webp`,
        sidecar_path: `originals/${a.actor}/${a.photoId}/fixture.xmp` })).error).toBeNull();
      const { lease, claimed } = await claim(a); expect(claimed.status).toBe('claimed');
      await store(a); // every other finalize check is satisfiable, so the refusal is this one
      expect(await refused('photo_finalize_upload', finalizeArgs(a, lease, claimed))).toBe('invalid_input');
      expect(await copies(a.digest)).toBe(0);
    });

    it('album only: stored with no project, in that album', async () => {
      const b = await album('Christmas Party');
      const a = await attempt(null, [b]);
      expect(await ledger(a)).toMatchObject({ job_id: null, album_ids: [b] });
      const { lease, claimed } = await claim(a); expect(claimed.status).toBe('claimed');
      await store(a);
      const args = finalizeArgs(a, lease, claimed);
      const outcome = await rpc('photo_finalize_upload', args);
      expect(outcome).toEqual({ status: 'created', photo_id: a.photoId, job_id: null });
      expect(await projectOf(a.photoId)).toBeNull();
      expect((await f.sql.query('select album_id,photo_id,added_by from public.album_photos where photo_id=$1', [a.photoId])).rows)
        .toEqual([{ album_id: b, photo_id: a.photoId, added_by: f.employeeA.id }]);
      expect((await ledger(a)).status).toBe('completed');
      expect(await rpc('photo_finalize_upload', args)).toEqual(outcome); // lost-response replay
      expect(await members(a.photoId)).toEqual([b]);
    });

    it('project only: as today, and the nine-argument call of the app that is live still resolves', async () => {
      const jobId = await job(); const a = draft(jobId, []);
      const { p_album_ids: _omitted, ...liveAppArgs } = createArgs(a);
      const created = await rpc('photo_create_upload_attempt', liveAppArgs);
      expect(created).toMatchObject({ job_id: jobId, album_ids: [] });
      expect(await rpc('photo_create_upload_attempt', liveAppArgs)).toMatchObject({ id: a.id }); // replay
      const { lease, claimed } = await claim(a); await store(a);
      expect(await rpc('photo_finalize_upload', finalizeArgs(a, lease, claimed))).toEqual({ status: 'created', photo_id: a.photoId, job_id: jobId });
      expect(await projectOf(a.photoId)).toBe(jobId);
      expect(await members(a.photoId)).toEqual([]);
      // Exactly one candidate, or the live app's named-parameter call would be ambiguous.
      expect((await f.sql.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace and proname='photo_create_upload_attempt'")).rows[0].n).toBe(1);
    });

    it('both: a project and two albums; the album list is part of the attempt', async () => {
      const jobId = await job(); const [x, y] = [await album('First'), await album('Second')];
      const a = await attempt(jobId, [y, x, y]); // order and repeats do not matter
      expect((await ledger(a)).album_ids).toEqual([x, y].sort());
      expect(await rpc('photo_create_upload_attempt', { ...createArgs(a), p_album_ids: [x, y] })).toMatchObject({ id: a.id });
      expect(await refused('photo_create_upload_attempt', { ...createArgs(a), p_album_ids: [x] })).toBe('conflict');
      const { lease, claimed } = await claim(a); await store(a);
      await rpc('photo_finalize_upload', finalizeArgs(a, lease, claimed));
      expect(await projectOf(a.photoId)).toBe(jobId);
      expect(await members(a.photoId)).toEqual([x, y].sort());
    });
  });

  describe('AC-7: the same-photo rule', () => {
    // A repeat upload is normally caught at claim, before any bytes move. It can
    // also be caught late, at finalize, when the first copy lands in between.
    for (const caught of ['claim', 'finalize'] as const) for (const project of ['empty', 'same', 'different'] as const) {
      it(`${project} project, caught at ${caught}: no second photo, and it joins album B`, async () => {
        const uploadJob = await job(); const otherJob = await job(); const b = await album('B');
        const a = await attempt(uploadJob, [b]);
        const existingJob = project === 'empty' ? null : project === 'same' ? uploadJob : otherJob;
        let outcome;
        if (caught === 'claim') {
          const existing = await photo({ jobId: existingJob, digest: a.digest });
          outcome = (await claim(a)).claimed;
          expect(outcome.photo_id).toBe(existing);
        } else {
          const { lease, claimed } = await claim(a); expect(claimed.status).toBe('claimed'); await store(a);
          const existing = await photo({ jobId: existingJob, digest: a.digest });
          outcome = await rpc('photo_finalize_upload', finalizeArgs(a, lease, claimed));
          expect(outcome.photo_id).toBe(existing);
        }
        expect(outcome.status).toBe('duplicate_active');
        expect(await copies(a.digest)).toBe(1);
        expect(await members(outcome.photo_id)).toEqual([b]);
        // empty -> filled in; same -> nothing; different -> kept, and reported job_conflict.
        const kept = project === 'different' ? otherJob : uploadJob;
        expect(await projectOf(outcome.photo_id)).toBe(kept);
        expect(outcome.job_id).toBe(kept);
        expect(await ledger(a)).toMatchObject({ status: project === 'different' ? 'job_conflict' : 'skipped_duplicate', result: outcome });
        expect((await f.sql.query('select 1 from public.photos where id=$1', [a.photoId])).rows).toEqual([]);
      });
    }

    it('an album-only upload of a photo that already has a project joins the album and keeps the project', async () => {
      const existingJob = await job(); const b = await album('Marketing');
      const a = await attempt(null, [b]);
      const existing = await photo({ jobId: existingJob, digest: a.digest });
      const outcome = (await claim(a)).claimed;
      expect(outcome).toMatchObject({ status: 'duplicate_active', photo_id: existing, job_id: existingJob });
      expect(await projectOf(existing)).toBe(existingJob);
      expect(await members(existing)).toEqual([b]);
      expect((await ledger(a)).status).toBe('skipped_duplicate'); // naming no project cannot conflict
      expect(await copies(a.digest)).toBe(1);
    });

    it('repeating the same upload into the same album changes nothing', async () => {
      const jobId = await job(); const b = await album('Repeat');
      const bytes = randomBytes(8);
      const first = await attempt(jobId, [b], bytes); const second = await attempt(jobId, [b], bytes);
      const existing = await photo({ jobId, digest: first.digest });
      for (const a of [first, second]) expect((await claim(a)).claimed.status).toBe('duplicate_active');
      expect(await members(existing)).toEqual([b]);
      expect((await f.sql.query('select added_by from public.album_photos where photo_id=$1', [existing])).rows).toEqual([{ added_by: f.employeeA.id }]);
    });

    it('a trashed copy is left alone; after the restore the rule applies on the next try', async () => {
      const uploadJob = await job(); const b = await album('After restore');
      const a = await attempt(uploadJob, [b]);
      const existing = await photo({ jobId: null, digest: a.digest, trashed: true });
      const outcome = (await claim(a)).claimed;
      expect(outcome).toMatchObject({ status: 'duplicate_trashed', photo_id: existing });
      expect((await ledger(a)).status).toBe('restore_required');
      expect(await members(existing)).toEqual([]);
      expect(await projectOf(existing)).toBeNull();
      expect((await f.admin.from('photos').update({ deleted_at: null, deleted_by: null, purge_after: null }).eq('id', existing)).error).toBeNull();
      const retried = await rpc('photo_create_upload_attempt', createArgs(a));
      expect(retried.result).toMatchObject({ status: 'duplicate_active', photo_id: existing, job_id: uploadJob });
      expect(await ledger(a)).toMatchObject({ status: 'skipped_duplicate', result: retried.result });
      expect(await members(existing)).toEqual([b]);
      expect(await projectOf(existing)).toBe(uploadJob);
    });
  });

  /** The real confirm flow: draft, list the exact photo, approve, apply. */
  async function act(actor: string, action: 'move' | 'trash' | 'restore', photoId: string, destination: string | null = null) {
    const batch = await draftAction(actor, action, photoId, destination);
    await rpc('photo_approve_action', { p_actor: actor, p_batch_id: batch });
    return (await rpc('photo_execute_action', { p_actor: actor, p_batch_id: batch, p_photo_ids: [photoId] }))[0] as { status: string };
  }
  async function draftAction(actor: string, action: 'move' | 'trash' | 'restore', photoId: string, destination: string | null = null) {
    const inserted = await f.admin.from('photo_action_batches').insert({ created_by: actor, origin: action === 'move' ? 'ui' : 'ordinary',
      action, selector: { photos: [{ photo_id: photoId }] }, destination_job_id: destination }).select('id').single();
    expect(inserted.error).toBeNull();
    const batch = inserted.data!.id as string;
    await rpc('photo_materialize_action', { p_actor: actor, p_batch_id: batch, p_cursor: null, p_ids: [photoId], p_next_cursor: '1', p_complete: true });
    return batch;
  }
  const summary = async (client: typeof f.admin, albumId: string) =>
    ((await client.rpc('get_photo_album_summaries', {})).data as Array<{ id: string; name: string; photo_count: number; thumbs: string[] }>)
      .find(row => row.id === albumId);
  /** What the signed-in employee's own session can see of an album's membership. */
  const visibleMembers = async (albumId: string) =>
    ((await f.employeeA.client.from('album_photos').select('photo_id').eq('album_id', albumId)).data ?? []).map(row => row.photo_id as string);

  describe('AC-8: a photo in several albums; deleting an album; trashing, restoring and purging a photo', () => {
    it('one photo sits in two albums, and each album counts it', async () => {
      const id = await photo(); const [x, y] = [await album('Two albums X'), await album('Two albums Y')];
      for (const target of [x, y]) expect(await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id] })).toEqual({ added: 1, already: 0, missing: 0 });
      expect(await members(id)).toEqual([x, y].sort());
      for (const target of [x, y]) expect(await summary(f.employeeA.client, target)).toMatchObject({ photo_count: 1, thumbs: [`derived/${f.employeeB.id}/${id}_thumb.webp`] });
    });

    it('deleting an album removes no photo; any employee can restore it within 30 days, and not after', async () => {
      const id = await photo(); const target = await album('Deleted then restored');
      await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id] });
      // Decision 7: employee B deletes the album employee A made.
      const deleted = (await rpc('photo_delete_album', { p_actor: f.employeeB.id, p_album: target })).album;
      expect(deleted).toMatchObject({ id: target, deleted_by: f.employeeB.id }); expect(deleted.deleted_at).not.toBeNull();
      expect((await f.sql.query('select deleted_at from public.photos where id=$1', [id])).rows).toEqual([{ deleted_at: null }]);
      expect(await members(id)).toEqual([target]); // kept, so a restore brings the album back whole
      expect(await summary(f.employeeA.client, target)).toBeUndefined();
      expect((await f.employeeA.client.from('albums').select('id').eq('id', target)).data).toEqual([]);
      // A repeat delete does not restart the 30 days, and a deleted album takes no edits.
      expect((await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: target })).album).toEqual(deleted);
      expect(await refused('photo_rename_album', { p_actor: f.employeeA.id, p_album: target, p_name: 'Renamed' })).toBe('not_found');
      expect(await refused('photo_album_add', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id] })).toBe('not_found');
      expect(await refused('photo_album_remove', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id] })).toBe('not_found');
      const restored = (await rpc('photo_restore_album', { p_actor: f.employeeA.id, p_album: target })).album;
      expect(restored).toMatchObject({ id: target, deleted_at: null, deleted_by: null });
      expect(await summary(f.employeeA.client, target)).toMatchObject({ name: 'Deleted then restored', photo_count: 1 });
      expect((await rpc('photo_restore_album', { p_actor: f.employeeA.id, p_album: target })).album).toEqual(restored); // repeat-safe
      await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: target });
      await f.sql.query("update public.albums set deleted_at=deleted_at-interval '30 days' where id=$1", [target]);
      expect(await refused('photo_restore_album', { p_actor: f.employeeA.id, p_album: target })).toBe('conflict');
      expect((await f.sql.query('select 1 from public.albums where id=$1', [target])).rows).toHaveLength(1); // never auto-purged
      expect(await refused('photo_restore_album', { p_actor: f.employeeA.id, p_album: randomUUID() })).toBe('not_found');
    });

    it('a trashed photo is hidden from the album and its count, a restore brings it back, a purge removes the membership', async () => {
      const id = await photo(); const keep = await photo(); const target = await album('Trash, restore, purge');
      await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id, keep] });
      expect((await summary(f.employeeA.client, target))?.photo_count).toBe(2);

      expect((await act(f.employeeB.id, 'trash', id)).status).toBe('applied');
      expect(await members(id)).toEqual([target]); // the row is kept...
      for (const client of [f.employeeA.client, f.admin]) { // ...but hidden, for an employee and for the service role alike
        expect(await summary(client, target)).toMatchObject({ photo_count: 1, thumbs: [`derived/${f.employeeB.id}/${keep}_thumb.webp`] });
      }
      expect(await visibleMembers(target)).toEqual([keep]);
      // Bulk tools act on active photos only, so the trashed photo keeps its place.
      expect(await rpc('photo_album_remove', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: [id] })).toEqual({ removed: 0 });
      expect(await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: await album('No trashed photos'), p_photo_ids: [id] })).toEqual({ added: 0, already: 0, missing: 1 });

      expect((await act(f.employeeA.id, 'restore', id)).status).toBe('applied');
      expect((await summary(f.employeeA.client, target))?.photo_count).toBe(2);
      expect((await visibleMembers(target)).sort()).toEqual([id, keep].sort());

      // Purge through the real repair functions, once the 30 days have passed.
      expect((await act(f.employeeA.id, 'trash', id)).status).toBe('applied');
      await f.sql.query(`update public.photos set deleted_at=t.at-interval '31 days',purge_after=t.at-interval '1 day'
        from (select date_trunc('milliseconds',statement_timestamp()) as at) t where id=$1`, [id]);
      await f.sql.query("update public.photo_repair_progress set lease_expires_at=clock_timestamp()-interval '1 second'");
      const holder = randomUUID();
      const lease = { p_holder: holder, p_generation: (await rpc('photo_repair_acquire', { p_holder: holder })).lease_generation };
      expect((await rpc('photo_repair_claim_purge', { ...lease, p_limit: 500 })).some((row: { id: string }) => row.id === id)).toBe(true);
      for (const path of [`originals/${f.employeeB.id}/${id}/fixture.jpg`, `derived/${f.employeeB.id}/${id}_thumb.webp`]) {
        expect(await rpc('photo_repair_authorize_delete', { ...lease, p_path: path, p_photo_id: id })).toBe(true);
      }
      expect(await rpc('photo_repair_finish_purge', { ...lease, p_photo_id: id })).toBe(true);
      expect((await f.sql.query('select 1 from public.photos where id=$1', [id])).rows).toEqual([]);
      expect(await members(id)).toEqual([]);
      expect(await members(keep)).toEqual([target]);
      expect(await summary(f.employeeA.client, target)).toMatchObject({ photo_count: 1 }); // the album itself is untouched
    });
  });

  /** Many active photos in one statement; returns their ids. */
  async function manyPhotos(count: number, tags: string[] = []) {
    const jobId = await job();
    return (await f.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,captured_at,original_path,tags)
      select g.id,$1::uuid,$2::uuid,'image',clock_timestamp(),'originals/'||($2::uuid)::text||'/'||g.id::text||'/bulk.jpg',$4::text[]
      from (select gen_random_uuid() as id from generate_series(1,$3::int)) g returning id`, [jobId, f.employeeB.id, count, tags])).rows.map(row => row.id as string);
  }
  /** Scenarios own their rows: a 500-photo fixture is removed again so later files see a small library. */
  const discard = (ids: string[]) => f.sql.query('delete from public.photos where id=any($1::uuid[])', [ids]);
  const tagsOf = async (photoId: string) => (await f.sql.query('select tags from public.photos where id=$1', [photoId])).rows[0].tags as string[];

  describe('AC-9: adding and removing up to 500 photos is repeat-safe', () => {
    it('adds 500 at once, repeats without change, removes, and repeats the removal without change', async () => {
      const ids = await manyPhotos(500); const target = await album('Five hundred');
      const add = { p_actor: f.employeeA.id, p_album: target, p_photo_ids: ids };
      expect(await rpc('photo_album_add', add)).toEqual({ added: 500, already: 0, missing: 0 });
      expect(await rpc('photo_album_add', add)).toEqual({ added: 0, already: 500, missing: 0 });
      expect((await summary(f.employeeA.client, target))?.photo_count).toBe(500);
      const some = { ...add, p_photo_ids: ids.slice(0, 200) };
      expect(await rpc('photo_album_remove', some)).toEqual({ removed: 200 });
      expect(await rpc('photo_album_remove', some)).toEqual({ removed: 0 });
      expect((await summary(f.employeeA.client, target))?.photo_count).toBe(300);
      // A partly-present request adds only what is missing.
      expect(await rpc('photo_album_add', add)).toEqual({ added: 200, already: 300, missing: 0 });
      // An unknown id is counted, and does not fail the rest.
      expect(await rpc('photo_album_add', { ...add, p_album: await album('With a stranger'), p_photo_ids: [ids[0], randomUUID()] }))
        .toEqual({ added: 1, already: 0, missing: 1 });
      await discard(ids);
      expect((await f.sql.query('select count(*)::int as n from public.album_photos where album_id=$1', [target])).rows[0].n).toBe(0); // memberships went with them
    });

    it('refuses 501 ids and an empty list, for add, remove and tag alike', async () => {
      const target = await album('Limits'); const tooMany = Array.from({ length: 501 }, () => randomUUID());
      for (const ids of [tooMany, [], null]) {
        expect(await refused('photo_album_add', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: ids })).toBe('invalid_input');
        expect(await refused('photo_album_remove', { p_actor: f.employeeA.id, p_album: target, p_photo_ids: ids })).toBe('invalid_input');
        expect(await refused('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: ids, p_add: ['limit'] })).toBe('invalid_input');
      }
      expect(await members(tooMany[0])).toEqual([]);
      expect(await refused('photo_album_add', { p_actor: f.employeeA.id, p_album: randomUUID(), p_photo_ids: [randomUUID()] })).toBe('not_found');
    });
  });

  describe('AC-10: bulk tagging', () => {
    it('adds and removes across 500 photos, and a repeat changes nothing', async () => {
      const ids = await manyPhotos(500, ['before', 'stays']); const tag = `bulk-${randomUUID()}`;
      const call = { p_actor: f.employeeA.id, p_photo_ids: ids, p_add: [tag], p_remove: ['before'] };
      expect(await rpc('photo_bulk_tag', call)).toEqual({ updated: 500, skipped: 0, missing: 0 });
      expect((await f.sql.query('select count(*)::int as n from public.photos where id=any($1::uuid[]) and tags=$2::text[]', [ids, ['stays', tag]])).rows[0].n).toBe(500);
      expect(await rpc('photo_bulk_tag', call)).toEqual({ updated: 500, skipped: 0, missing: 0 });
      expect(await tagsOf(ids[0])).toEqual(['stays', tag]);
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [ids[0]], p_remove: [tag.toUpperCase()] })).toEqual({ updated: 1, skipped: 0, missing: 0 });
      expect(await tagsOf(ids[0])).toEqual(['stays']); // removal ignores case
      await discard(ids);
    });

    it('skips and counts a photo at the 20-tag limit, leaving it entirely unchanged', async () => {
      const full = Array.from({ length: 20 }, (_, index) => `limit-${index}`); const tag = `over-${randomUUID()}`;
      const atLimit = await photo({ tags: full }); const roomy = await photo({ tags: ['limit-0'] }); const trashed = await photo({ trashed: true });
      // A plain add: the full photo cannot take a 21st tag. Trashed and unknown ids are counted apart.
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [atLimit, roomy, trashed, randomUUID()], p_add: [tag] }))
        .toEqual({ updated: 1, skipped: 1, missing: 2 });
      expect(await tagsOf(atLimit)).toEqual(full);
      expect(await tagsOf(roomy)).toEqual(['limit-0', tag]);
      expect(await tagsOf(trashed)).toEqual([]);
      // "Entirely unchanged": a skipped photo does not get the removal half of the request either (20 - 1 + 2 = 21).
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [atLimit], p_add: [`a-${tag}`, `b-${tag}`], p_remove: ['limit-0'] }))
        .toEqual({ updated: 0, skipped: 1, missing: 0 });
      expect(await tagsOf(atLimit)).toEqual(full);
      // Trading one tag for another still fits in 20, so it is applied.
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [atLimit], p_add: [tag], p_remove: ['limit-0'] }))
        .toEqual({ updated: 1, skipped: 0, missing: 0 });
      expect(await tagsOf(atLimit)).toEqual([...full.slice(1), tag]);
      // Adding a tag the photo already holds is not a 21st tag.
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [atLimit], p_add: [tag.toUpperCase()] }))
        .toEqual({ updated: 1, skipped: 0, missing: 0 });
      expect(await tagsOf(atLimit)).toEqual([...full.slice(1), tag]);
    });

    it('stores the existing spelling: adding Kitchen when kitchen exists stores kitchen', async () => {
      const unique = randomUUID().slice(0, 8); const stored = `kitchen-${unique}`; const typed = `Kitchen-${unique}`;
      // Two photos hold the stored spelling and one holds another, so the most used spelling is unambiguous.
      await photo({ tags: [stored] }); await photo({ tags: [stored] });
      const target = await photo(); const already = await photo({ tags: [stored.toUpperCase()] });
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [target, already], p_add: [typed] })).toEqual({ updated: 2, skipped: 0, missing: 0 });
      expect(await tagsOf(target)).toEqual([stored]);
      expect(await tagsOf(already)).toEqual([stored.toUpperCase()]); // no second spelling beside the one it holds
      // A brand-new tag is stored as typed, trimmed.
      const fresh = `Fresh Tag ${unique}`;
      await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [target], p_add: [`  ${fresh}  `] });
      expect(await tagsOf(target)).toEqual([stored, fresh]);
    });

    it('refuses empty, over-long, and contradictory tag lists', async () => {
      const id = await photo(); const base = { p_actor: f.employeeA.id, p_photo_ids: [id] };
      for (const bad of [{}, { p_add: [], p_remove: [] }, { p_add: ['   '] }, { p_add: ['x'.repeat(65)] },
        { p_add: Array.from({ length: 21 }, (_, index) => `t${index}`) }, { p_add: ['Same'], p_remove: ['same'] }]) {
        expect(await refused('photo_bulk_tag', { ...base, ...bad })).toBe('invalid_input');
      }
      expect(await tagsOf(id)).toEqual([]);
    });
  });

  describe('actions on a photo with no project (Decision 1; move to "No project")', () => {
    it('a move with no destination clears the project; trash and restore then work on the project-less photo', async () => {
      const from = await job(); const id = await photo({ jobId: from });
      expect((await act(f.employeeA.id, 'move', id, null)).status).toBe('applied');
      expect(await projectOf(id)).toBeNull();
      // Another employee confirms the same move afterwards: already true, so applied, not conflict.
      const again = await draftAction(f.employeeB.id, 'move', id, null);
      await rpc('photo_approve_action', { p_actor: f.employeeB.id, p_batch_id: again });
      expect((await rpc('photo_execute_action', { p_actor: f.employeeB.id, p_batch_id: again, p_photo_ids: [id] }))[0].status).toBe('applied');
      expect((await f.sql.query('select expected_job_id from public.photo_action_items where batch_id=$1', [again])).rows).toEqual([{ expected_job_id: null }]);
      expect((await act(f.employeeB.id, 'trash', id)).status).toBe('applied');
      expect((await f.sql.query('select deleted_by,job_id from public.photos where id=$1', [id])).rows).toEqual([{ deleted_by: f.employeeB.id, job_id: null }]);
      expect((await act(f.employeeA.id, 'restore', id)).status).toBe('applied');
      expect((await f.sql.query('select deleted_at,job_id from public.photos where id=$1', [id])).rows).toEqual([{ deleted_at: null, job_id: null }]);
      // And back into a project.
      const to = await job();
      expect((await act(f.employeeA.id, 'move', id, to)).status).toBe('applied');
      expect(await projectOf(id)).toBe(to);
    });

    it('a project given after the photo was listed is still a conflict, not a silent success', async () => {
      // Listed for trash while it had no project...
      const id = await photo({ jobId: null });
      const listed = await draftAction(f.employeeA.id, 'trash', id);
      await rpc('photo_approve_action', { p_actor: f.employeeA.id, p_batch_id: listed });
      // ...then someone else files it under a project and trashes it.
      expect((await act(f.employeeB.id, 'move', id, await job())).status).toBe('applied');
      expect((await act(f.employeeB.id, 'trash', id)).status).toBe('applied');
      // With `=` this comparison was unknown for an empty project and the item was marked applied.
      expect((await rpc('photo_execute_action', { p_actor: f.employeeA.id, p_batch_id: listed, p_photo_ids: [id] }))[0].status).toBe('conflict');
    });
  });

  describe('authority: any signed-in employee, through the service role only (Decision 7)', () => {
    it('employee B renames an album employee A made; no role is consulted', async () => {
      const target = await album('Made by A', f.employeeA.id);
      expect((await rpc('photo_rename_album', { p_actor: f.employeeB.id, p_album: target, p_name: '  Renamed   by  B ' })).album)
        .toMatchObject({ id: target, name: 'Renamed by B', created_by: f.employeeA.id });
      for (const name of ['', '   ', 'x'.repeat(121)]) {
        expect(await refused('photo_create_album', { p_actor: f.employeeA.id, p_name: name })).toBe('invalid_input');
        expect(await refused('photo_rename_album', { p_actor: f.employeeA.id, p_album: target, p_name: name })).toBe('invalid_input');
      }
      // Names need not be unique (Decision 2).
      expect(await album('Made by A')).not.toBe(await album('Made by A'));
    });

    const calls = (): Array<[string, Record<string, unknown>]> => [
      ['photo_create_album', { p_actor: f.employeeA.id, p_name: 'Guarded' }],
      ['photo_rename_album', { p_actor: f.employeeA.id, p_album: randomUUID(), p_name: 'Guarded' }],
      ['photo_delete_album', { p_actor: f.employeeA.id, p_album: randomUUID() }],
      ['photo_restore_album', { p_actor: f.employeeA.id, p_album: randomUUID() }],
      ['photo_album_add', { p_actor: f.employeeA.id, p_album: randomUUID(), p_photo_ids: [randomUUID()] }],
      ['photo_album_remove', { p_actor: f.employeeA.id, p_album: randomUUID(), p_photo_ids: [randomUUID()] }],
      ['photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [randomUUID()], p_add: ['guarded'] }],
    ];

    it('every new write function needs a live actor and the open writes gate', async () => {
      for (const [name, args] of calls()) expect(await refused(name, { ...args, p_actor: randomUUID() }), name).toBe('invalid_actor');
      await f.sql.query('update public.photo_release_state set photo_writes_enabled=false');
      try {
        for (const [name, args] of calls()) expect(await refused(name, args), name).toBe('photo_gate_closed');
      } finally {
        await f.sql.query('update public.photo_release_state set photo_writes_enabled=true');
      }
    });

    it('a browser session can read but never write, and the internal helpers stay internal', async () => {
      for (const client of [f.employeeA.client, f.anon]) {
        for (const [name, args] of calls()) expect((await client.rpc(name, args)).error, name).not.toBeNull();
      }
      const target = await album('Read only'); const id = await photo();
      expect((await f.employeeA.client.from('albums').insert({ name: 'Direct', created_by: f.employeeA.id })).error).not.toBeNull();
      expect((await f.employeeA.client.from('albums').update({ name: 'Direct' }).eq('id', target).select('id')).error).not.toBeNull();
      expect((await f.employeeA.client.from('albums').delete().eq('id', target).select('id')).error).not.toBeNull();
      expect((await f.employeeA.client.from('album_photos').insert({ album_id: target, photo_id: id, added_by: f.employeeA.id })).error).not.toBeNull();
      expect((await f.employeeA.client.from('albums').select('id,name').eq('id', target)).data).toEqual([{ id: target, name: 'Read only' }]);
      expect((await f.anon.from('albums').select('id').eq('id', target)).data ?? []).toEqual([]);
      expect((await f.anon.rpc('get_photo_album_summaries', {})).error).not.toBeNull();
      expect((await f.employeeA.client.rpc('get_photo_album_summaries', { q: 'read onl' })).data?.map((row: { id: string }) => row.id)).toContain(target);
      // Not even the service role may call these directly.
      expect((await f.admin.rpc('photo_same_photo_outcome', { p_actor: f.employeeA.id, p_digest: 'a'.repeat(64), p_job: null, p_album_ids: [] })).error).not.toBeNull();
      expect((await f.admin.rpc('photo_clean_tags', { p_tags: ['x'] })).error).not.toBeNull();
      // Restating grants by name did not hand this one back.
      expect((await f.sql.query("select has_function_privilege('service_role','public.photo_record_upload_outcome(uuid,text,uuid,bigint,uuid,jsonb,jsonb)','execute') as allowed")).rows[0].allowed).toBe(false);
    });
  });
});
