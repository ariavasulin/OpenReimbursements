import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// 20260923120000_photo_manage_and_purge.sql: rename a photo, renumber a project,
// delete and restore a project, and delete Trash forever. Every scenario owns its rows.
describe('managing photos, projects, albums, and Trash', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true');
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) => (await f.admin.rpc(name, args)).error?.message;
  const number = () => randomUUID().slice(0, 8);
  const project = async (name = 'Manage fixture', jobNumber: string | null = number()) =>
    (await rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: name, p_job_number: jobNumber })).job as { id: string; job_number: string };
  async function photo(jobId: string | null, options: { trashed?: boolean; duplicateOf?: string } = {}) {
    const id = randomUUID(); const now = Date.now();
    const inserted = await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeB.id, kind: 'image',
      captured_at: new Date(now).toISOString(), original_path: `originals/${f.employeeB.id}/${id}/fixture.jpg`,
      thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`, duplicate_of: options.duplicateOf ?? null,
      legacy_content_sha256: options.duplicateOf ? 'a'.repeat(64) : null,
      ...(options.trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id,
        purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    return id;
  }
  const row = async (table: string, id: string) =>
    (await f.sql.query(`select * from public.${table} where id=$1`, [id])).rows[0];
  const album = async (name = 'Manage album') =>
    (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: name })).album.id as string;
  /** The real confirm flow, as the albums suite drives it. */
  async function act(action: 'trash' | 'restore', photoId: string) {
    const inserted = await f.admin.from('photo_action_batches').insert({ created_by: f.employeeA.id, origin: 'ordinary',
      action, selector: { photos: [{ photo_id: photoId }] } }).select('id').single();
    expect(inserted.error).toBeNull();
    const batch = inserted.data!.id as string;
    await rpc('photo_materialize_action', { p_actor: f.employeeA.id, p_batch_id: batch, p_cursor: null, p_ids: [photoId], p_next_cursor: '1', p_complete: true });
    await rpc('photo_approve_action', { p_actor: f.employeeA.id, p_batch_id: batch });
    return (await rpc('photo_execute_action', { p_actor: f.employeeA.id, p_batch_id: batch, p_photo_ids: [photoId] }))[0] as { status: string };
  }
  /** Drive the three purge steps as the route does, with no Storage objects to remove. */
  async function drain() {
    let purged = 0;
    for (const pending of await rpc('photo_purge_pending', { p_actor: f.employeeA.id, p_limit: 500 }) as Array<{ id: string; paths: string[] }>) {
      for (const path of pending.paths) await rpc('photo_purge_authorize_delete', { p_actor: f.employeeA.id, p_path: path, p_photo_id: pending.id });
      if (await rpc('photo_purge_finish', { p_actor: f.employeeA.id, p_photo_id: pending.id })) purged++;
    }
    return purged;
  }

  describe('photo names', () => {
    it('any employee renames an active photo; blank goes back to the uploaded filename; sessions cannot write it', async () => {
      const id = await photo(null);
      expect(await rpc('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: id, p_name: '  Kitchen   before ' }))
        .toEqual({ id, display_name: 'Kitchen before' });
      expect(await refused('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: id, p_name: 'a/b' })).toBe('invalid_input');
      expect(await refused('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: id, p_name: 'x'.repeat(201) })).toBe('invalid_input');
      expect((await rpc('photo_rename_photo', { p_actor: f.employeeB.id, p_photo: id, p_name: '   ' })).display_name).toBeNull();
      expect(await refused('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: await photo(null, { trashed: true }), p_name: 'x' })).toBe('not_found');
      expect((await f.employeeA.client.from('photos').update({ display_name: 'Direct' }).eq('id', id)).error).not.toBeNull();
      expect((await f.employeeA.client.rpc('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: id, p_name: 'Direct' })).error).not.toBeNull();
    });
  });

  describe('project numbers', () => {
    it('renames the name and the number; the current number, a P- code included, may be sent back unchanged', async () => {
      const job = await project('Before');
      const renumbered = (await rpc('photo_rename_job', { p_actor: f.employeeB.id, p_job_id: job.id, p_name: 'After', p_job_number: ' 7777x ' })).job;
      expect(renumbered).toMatchObject({ id: job.id, name: 'After', job_number: '7777x' });
      const generated = await project('Generated', null);
      expect(generated.job_number).toMatch(/^P-\d+$/);
      expect((await rpc('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: generated.id, p_name: 'Kept', p_job_number: generated.job_number })).job)
        .toMatchObject({ name: 'Kept', job_number: generated.job_number });
      // The old three-argument call still works and keeps the number.
      expect((await rpc('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: job.id, p_name: 'Name only' })).job.job_number).toBe('7777x');
    });

    it('refuses a number another project holds, a typed P- code, and an oversized number', async () => {
      const [a, b] = [await project('Holder'), await project('Wants it')];
      expect(await refused('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: b.id, p_name: 'x', p_job_number: a.job_number })).toBe('job_number_taken');
      expect(await refused('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: b.id, p_name: 'x', p_job_number: 'p-1' })).toBe('invalid_input');
      expect(await refused('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: b.id, p_name: 'x', p_job_number: 'x'.repeat(33) })).toBe('invalid_input');
    });
  });

  describe('deleting and restoring a project', () => {
    it('sends the project and its active photos to Trash, and a restore brings back only those photos', async () => {
      const job = await project();
      const [a, b] = [await photo(job.id), await photo(job.id)];
      const earlier = await photo(job.id, { trashed: true });
      const deleted = await rpc('photo_delete_job', { p_actor: f.employeeA.id, p_job: job.id });
      expect(deleted).toMatchObject({ trashed: 2, job: { id: job.id, is_active: false } });
      expect((await row('photos', a)).deleted_at).toEqual((await row('jobs', job.id)).deleted_at);
      // Hidden from the project list, refused for uploads and renames, and repeat-safe.
      const listed = (await f.employeeA.client.rpc('get_photo_job_summaries', { search_query: job.job_number })).data as Array<{ id: string }>;
      expect(listed.some(listedJob => listedJob.id === job.id)).toBe(false);
      expect(await refused('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: job.id, p_name: 'x' })).toBe('not_found');
      expect((await rpc('photo_delete_job', { p_actor: f.employeeB.id, p_job: job.id })).trashed).toBe(0);
      // The number is still held while the project is in Trash.
      expect(await refused('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Same number', p_job_number: job.job_number })).toBe('job_in_trash');

      const restored = await rpc('photo_restore_job', { p_actor: f.employeeB.id, p_job: job.id });
      expect(restored).toMatchObject({ restored: 2, job: { is_active: true, deleted_at: null } });
      for (const id of [a, b]) expect((await row('photos', id)).deleted_at).toBeNull();
      expect((await row('photos', earlier)).deleted_at).not.toBeNull();
    });

    it('a photo restored on its own while its project is deleted comes back with no project', async () => {
      const job = await project();
      const id = await photo(job.id);
      await rpc('photo_delete_job', { p_actor: f.employeeA.id, p_job: job.id });
      expect((await act('restore', id)).status).toBe('applied');
      expect(await row('photos', id)).toMatchObject({ deleted_at: null, job_id: null });
    });

    it('cannot restore after 30 days', async () => {
      const job = await project();
      await rpc('photo_delete_job', { p_actor: f.employeeA.id, p_job: job.id });
      await f.sql.query("update public.jobs set deleted_at=now()-interval '31 days' where id=$1", [job.id]);
      expect(await refused('photo_restore_job', { p_actor: f.employeeA.id, p_job: job.id })).toBe('conflict');
      expect(await refused('photo_delete_job', { p_actor: f.employeeA.id, p_job: randomUUID() })).toBe('not_found');
    });
  });

  describe('deleting forever', () => {
    it('removes named trashed photos only; an active photo is untouched', async () => {
      const job = await project();
      const [trashed, active] = [await photo(job.id, { trashed: true }), await photo(job.id)];
      expect(await rpc('photo_purge_request', { p_actor: f.employeeA.id, p_photo_ids: [trashed, active] })).toEqual({ photos: 1, albums: 0, projects: 0 });
      // Marked: gone from the Trash list at once, and no longer restorable.
      expect((await row('photos', trashed)).purge_claimed_at).not.toBeNull();
      expect(await drain()).toBeGreaterThanOrEqual(1);
      expect(await row('photos', trashed)).toBeUndefined();
      expect((await row('photos', active)).deleted_at).toBeNull();
      expect((await f.sql.query('select 1 from public.photo_repair_retired_ids where id=$1', [trashed])).rowCount).toBe(1);
    });

    it('a deleted project goes with all its trashed photos, and its number is free again', async () => {
      const job = await project();
      const [a, earlier] = [await photo(job.id), await photo(job.id, { trashed: true })];
      await rpc('photo_delete_job', { p_actor: f.employeeA.id, p_job: job.id });
      expect(await rpc('photo_purge_request', { p_actor: f.employeeA.id, p_job_ids: [job.id] })).toEqual({ photos: 2, albums: 0, projects: 1 });
      await drain();
      for (const id of [a, earlier]) expect(await row('photos', id)).toBeUndefined();
      expect(await row('jobs', job.id)).toMatchObject({ job_number: `deleted:${job.id}`, is_active: false });
      expect(await refused('photo_restore_job', { p_actor: f.employeeA.id, p_job: job.id })).toBe('not_found');
      expect((await rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Reused', p_job_number: job.job_number })).status).toBe('created');
    });

    it('a live project or album cannot be deleted forever; a deleted album goes, and can no longer be restored', async () => {
      const job = await project(); const live = await album(); const gone = await album();
      const member = await photo(null);
      await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: gone, p_photo_ids: [member] });
      await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: gone });
      expect(await rpc('photo_purge_request', { p_actor: f.employeeA.id, p_job_ids: [job.id], p_album_ids: [live, gone] }))
        .toEqual({ photos: 0, albums: 1, projects: 0 });
      expect((await row('albums', gone)).purged_at).not.toBeNull();
      expect((await row('albums', live)).purged_at).toBeNull();
      expect((await row('photos', member)).deleted_at).toBeNull(); // deleting an album never deletes a photo
      expect((await f.sql.query('select 1 from public.album_photos where album_id=$1', [gone])).rowCount).toBe(0);
      expect(await refused('photo_restore_album', { p_actor: f.employeeA.id, p_album: gone })).toBe('not_found');
    });

    it('a legacy copy is removed before the photo it points at', async () => {
      const original = await photo(null, { trashed: true });
      const copy = await photo(null, { trashed: true, duplicateOf: original });
      expect((await rpc('photo_purge_request', { p_actor: f.employeeA.id, p_photo_ids: [original] })).photos).toBe(2);
      const first = await rpc('photo_purge_pending', { p_actor: f.employeeA.id, p_limit: 500 }) as Array<{ id: string }>;
      expect(first.map(pending => pending.id)).toContain(copy);
      expect(first.map(pending => pending.id)).not.toContain(original);
      await drain(); await drain();
      expect(await row('photos', original)).toBeUndefined();
    });

    it('refuses an empty request, a closed write gate, and a session role', async () => {
      expect(await refused('photo_purge_request', { p_actor: f.employeeA.id })).toBe('invalid_input');
      expect((await f.employeeA.client.rpc('photo_purge_request', { p_actor: f.employeeA.id, p_everything: true })).error).not.toBeNull();
      await f.sql.query('update public.photo_release_state set photo_writes_enabled=false');
      try {
        expect(await refused('photo_purge_request', { p_actor: f.employeeA.id, p_everything: true })).toBe('photo_gate_closed');
        expect(await refused('photo_delete_job', { p_actor: f.employeeA.id, p_job: randomUUID() })).toBe('photo_gate_closed');
      } finally {
        await f.sql.query('update public.photo_release_state set photo_writes_enabled=true');
      }
    });

    it('everything empties the whole Trash', async () => {
      const job = await project(); const deletedAlbum = await album();
      const loose = await photo(null, { trashed: true });
      const inProject = await photo(job.id);
      await rpc('photo_delete_job', { p_actor: f.employeeA.id, p_job: job.id });
      await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: deletedAlbum });
      const marked = await rpc('photo_purge_request', { p_actor: f.employeeA.id, p_everything: true });
      expect(marked.photos).toBeGreaterThanOrEqual(2);
      expect(marked.albums).toBeGreaterThanOrEqual(1);
      expect(marked.projects).toBeGreaterThanOrEqual(1);
      while (await drain() > 0) { /* until nothing is left */ }
      // Other files' trashed rows may still own real Storage objects, which only the
      // route removes; this file's rows own none.
      for (const id of [loose, inProject]) expect(await row('photos', id)).toBeUndefined();
      expect((await row('albums', deletedAlbum)).purged_at).not.toBeNull();
    });
  });
});
