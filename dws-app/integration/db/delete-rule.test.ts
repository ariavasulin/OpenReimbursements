import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// 20261012182335_photo_admin_and_trash_rule.sql (plans/active/dws-photos-client-feedback, Decisions 1-2):
// photo admins delete anything; everyone else trashes only their own uploads of the last 30 days and
// deletes only albums they made; restore and every organizing tool stay open. Every scenario owns its rows.
describe('photo admins and the delete rule', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true, mcp_enabled=true');
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) => (await f.admin.rpc(name, args)).error?.message;
  const day = 86_400_000;
  async function photo(uploader: string, daysAgo = 0, options: { trashed?: boolean } = {}) {
    const id = randomUUID(); const now = Date.now();
    const inserted = await f.admin.from('photos').insert({ id, job_id: null, uploader_id: uploader, kind: 'image',
      captured_at: new Date(now).toISOString(), created_at: new Date(now - daysAgo * day).toISOString(),
      original_path: `originals/${uploader}/${id}/fixture.jpg`,
      ...(options.trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: uploader, purge_after: new Date(now + 30 * day).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    return id;
  }
  async function batch(actor: string, action: 'move' | 'trash' | 'restore', id: string, destination: string | null = null) {
    const inserted = await f.admin.from('photo_action_batches').insert({ created_by: actor, origin: action === 'move' ? 'ui' : 'ordinary',
      action, selector: { photos: [{ photo_id: id }] }, destination_job_id: destination }).select('id').single();
    expect(inserted.error).toBeNull();
    return inserted.data!.id as string;
  }
  const materialize = (actor: string, b: string, id: string) =>
    f.admin.rpc('photo_materialize_action', { p_actor: actor, p_batch_id: b, p_cursor: null, p_ids: [id], p_next_cursor: '1', p_complete: true });
  const approve = (actor: string, b: string) => f.admin.rpc('photo_approve_action', { p_actor: actor, p_batch_id: b });
  const execute = async (actor: string, b: string, id: string) =>
    (await rpc('photo_execute_action', { p_actor: actor, p_batch_id: b, p_photo_ids: [id] }))[0] as { status: string; code?: string };
  /** The whole confirm flow: list, approve, apply. */
  async function act(actor: string, action: 'move' | 'trash' | 'restore', id: string, destination: string | null = null) {
    const b = await batch(actor, action, id, destination);
    expect((await materialize(actor, b, id)).error).toBeNull();
    expect((await approve(actor, b)).error).toBeNull();
    return execute(actor, b, id);
  }
  const deletedAt = async (id: string) => (await f.sql.query('select deleted_at from public.photos where id=$1', [id])).rows[0]?.deleted_at;

  describe('AC-2: an employee trashes only their own uploads of the last 30 days', () => {
    it('own 29-day-old upload: yes; own 31-day-old upload and a colleague’s: forbidden', async () => {
      const recent = await photo(f.employeeA.id, 29);
      expect(await act(f.employeeA.id, 'trash', recent)).toMatchObject({ status: 'applied' });
      expect(await deletedAt(recent)).not.toBeNull();
      for (const id of [await photo(f.employeeA.id, 31), await photo(f.employeeB.id, 1)]) {
        expect((await materialize(f.employeeA.id, await batch(f.employeeA.id, 'trash', id), id)).error?.message).toBe('forbidden');
        expect(await deletedAt(id)).toBeNull();
      }
    });

    it('the MCP remove_photos hand-off refuses the same photos', async () => {
      async function handoff(id: string) {
        const digest = randomBytes(32).toString('hex');
        expect((await f.admin.from('dws_action_handoffs').insert({ token_digest: digest, script_name: 'remove_photos',
          requested_input: { selector: { photos: [{ photo_id: id }] } }, expires_at: new Date(Date.now() + 60_000).toISOString() })).error).toBeNull();
        return (await rpc('consume_dws_handoff', { p_actor: f.employeeA.id, p_token_digest: digest, p_script: 'remove_photos' })).photo_action_batch_id as string;
      }
      for (const id of [await photo(f.employeeA.id, 31), await photo(f.employeeB.id, 1)]) {
        expect((await materialize(f.employeeA.id, await handoff(id), id)).error?.message).toBe('forbidden');
      }
      const own = await photo(f.employeeA.id, 29), b = await handoff(own);
      expect((await materialize(f.employeeA.id, b, own)).error).toBeNull();
      expect((await approve(f.employeeA.id, b)).error).toBeNull();
      expect(await execute(f.employeeA.id, b, own)).toMatchObject({ status: 'applied' });
    });

    it('a photo that ages past 30 days before approval or before applying is refused at that step', async () => {
      const age = (id: string) => f.sql.query("update public.photos set created_at=now()-interval '31 days' where id=$1", [id]);
      const beforeApproval = await photo(f.employeeA.id, 29), b1 = await batch(f.employeeA.id, 'trash', beforeApproval);
      expect((await materialize(f.employeeA.id, b1, beforeApproval)).error).toBeNull();
      await age(beforeApproval);
      expect((await approve(f.employeeA.id, b1)).error?.message).toBe('forbidden');
      // Applying records it on the item, so the confirm page can say why.
      const beforeApply = await photo(f.employeeA.id, 29), b2 = await batch(f.employeeA.id, 'trash', beforeApply);
      expect((await materialize(f.employeeA.id, b2, beforeApply)).error).toBeNull();
      expect((await approve(f.employeeA.id, b2)).error).toBeNull();
      await age(beforeApply);
      expect(await execute(f.employeeA.id, b2, beforeApply)).toMatchObject({ status: 'conflict', code: 'forbidden' });
      expect((await f.sql.query('select status,error from public.photo_action_items where batch_id=$1', [b2])).rows)
        .toEqual([{ status: 'conflict', error: { code: 'forbidden' } }]);
      expect(await deletedAt(beforeApply)).toBeNull();
    });

    it('a photo admin trashes anyone’s photo of any age; a Receipts administrator is not a photo admin', async () => {
      const old = await photo(f.employeeB.id, 400);
      expect((await materialize(f.administrator.id, await batch(f.administrator.id, 'trash', old), old)).error?.message).toBe('forbidden');
      expect(await act(f.photoAdmin.id, 'trash', old)).toMatchObject({ status: 'applied' });
    });

    it('the flag is live at once, and nobody can set it on themselves', async () => {
      const id = await photo(f.employeeB.id, 1);
      await f.sql.query('update public.user_profiles set photo_admin=true where user_id=$1', [f.employeeA.id]);
      try {
        expect(await act(f.employeeA.id, 'trash', id)).toMatchObject({ status: 'applied' });
      } finally {
        await f.sql.query('update public.user_profiles set photo_admin=false where user_id=$1', [f.employeeA.id]);
      }
      expect((await f.employeeA.client.from('user_profiles').update({ photo_admin: true }).eq('user_id', f.employeeA.id)).error).not.toBeNull();
      expect((await f.sql.query('select photo_admin from public.user_profiles where user_id=$1', [f.employeeA.id])).rows[0].photo_admin).toBe(false);
      const policy = await f.sql.query(`select with_check from pg_policies where schemaname='public' and tablename='user_profiles' and policyname='user_profiles_insert_policy'`);
      expect(policy.rows[0].with_check).toMatch(/photo_admin/);
    });
  });

  describe('AC-1: Delete forever, Empty trash, and project Delete are for photo admins', () => {
    it('an employee and a Receipts administrator are refused every purge step and project delete; a photo admin is not', async () => {
      const trashed = await photo(f.employeeA.id, 0, { trashed: true });
      const job = (await rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Delete rule project', p_job_number: randomUUID().slice(0, 8) })).job.id as string;
      for (const actor of [f.employeeA.id, f.administrator.id]) {
        expect(await refused('photo_purge_request', { p_actor: actor, p_everything: true })).toBe('forbidden');
        expect(await refused('photo_purge_request', { p_actor: actor, p_photo_ids: [trashed] })).toBe('forbidden');
        expect(await refused('photo_purge_pending', { p_actor: actor, p_limit: 10 })).toBe('forbidden');
        expect(await refused('photo_purge_authorize_delete', { p_actor: actor, p_path: `originals/${f.employeeA.id}/${trashed}/fixture.jpg`, p_photo_id: trashed })).toBe('forbidden');
        expect(await refused('photo_purge_finish', { p_actor: actor, p_photo_id: trashed })).toBe('forbidden');
        expect(await refused('photo_delete_job', { p_actor: actor, p_job: job })).toBe('forbidden');
      }
      expect((await f.sql.query('select purge_claimed_at from public.photos where id=$1', [trashed])).rows[0].purge_claimed_at).toBeNull();
      expect((await f.sql.query('select deleted_at from public.jobs where id=$1', [job])).rows[0].deleted_at).toBeNull();
      expect(await rpc('photo_delete_job', { p_actor: f.photoAdmin.id, p_job: job })).toMatchObject({ job: { id: job, is_active: false } });
      expect(await rpc('photo_purge_request', { p_actor: f.photoAdmin.id, p_photo_ids: [trashed], p_job_ids: [job] })).toMatchObject({ photos: 1, projects: 1 });
      const pending = await rpc('photo_purge_pending', { p_actor: f.photoAdmin.id, p_limit: 500 }) as Array<{ id: string; paths: string[] }>;
      expect(pending.map(row => row.id)).toContain(trashed);
      for (const path of pending.find(row => row.id === trashed)!.paths) {
        await rpc('photo_purge_authorize_delete', { p_actor: f.photoAdmin.id, p_path: path, p_photo_id: trashed });
      }
      expect(await rpc('photo_purge_finish', { p_actor: f.photoAdmin.id, p_photo_id: trashed })).toBe(true);
    });

    it('an album: its maker deletes it, a colleague may not, a photo admin may; anyone restores it', async () => {
      const mine = (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: 'Made by A' })).album.id as string;
      expect(await refused('photo_delete_album', { p_actor: f.employeeB.id, p_album: mine })).toBe('forbidden');
      expect(await refused('photo_delete_album', { p_actor: f.administrator.id, p_album: mine })).toBe('forbidden');
      expect((await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: mine })).album.deleted_at).not.toBeNull();
      expect((await rpc('photo_restore_album', { p_actor: f.employeeB.id, p_album: mine })).album.deleted_at).toBeNull();
      expect((await rpc('photo_delete_album', { p_actor: f.photoAdmin.id, p_album: mine })).album.deleted_by).toBe(f.photoAdmin.id);
      expect(await refused('photo_delete_album', { p_actor: f.employeeB.id, p_album: randomUUID() })).toBe('not_found');
    });
  });

  describe('AC-3: restore and organizing stay open to every employee', () => {
    it('an employee restores, tags, renames, and moves a colleague’s photo, and creates a project and an album', async () => {
      const theirs = await photo(f.employeeB.id, 90);
      expect(await act(f.photoAdmin.id, 'trash', theirs)).toMatchObject({ status: 'applied' });
      expect(await act(f.employeeA.id, 'restore', theirs)).toMatchObject({ status: 'applied' });
      expect(await deletedAt(theirs)).toBeNull();
      expect(await rpc('photo_bulk_tag', { p_actor: f.employeeA.id, p_photo_ids: [theirs], p_add: ['delete-rule'] })).toMatchObject({ updated: 1 });
      expect((await rpc('photo_rename_photo', { p_actor: f.employeeA.id, p_photo: theirs, p_name: 'Renamed by A' })).display_name).toBe('Renamed by A');
      const created = await rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Made by A', p_job_number: randomUUID().slice(0, 8) });
      expect(created.status).toBe('created');
      expect(await act(f.employeeA.id, 'move', theirs, created.job.id)).toMatchObject({ status: 'applied' });
      expect((await f.sql.query('select job_id from public.photos where id=$1', [theirs])).rows[0].job_id).toBe(created.job.id);
      const albumId = (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: 'Made by A' })).album.id as string;
      expect(await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: albumId, p_photo_ids: [theirs] })).toMatchObject({ added: 1 });
    });
  });
});
