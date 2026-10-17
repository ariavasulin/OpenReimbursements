import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// Performance round 1, server and database package (migration 20261016140400_photo_perf_server_reads):
// the one-read actor check (DB-1), the one-read "me" (DB-5), album cards in one pass with their
// maker and order (DB-10, DB-7, GRID-6), and the reader's own favorites as a view (DB-2).
// Every scenario owns its rows.
describe('server reads in fewer round trips (performance round 1)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const madeJobs: string[] = [];
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set schema_generation=1,photo_writes_enabled=true,mcp_enabled=false,repair_enabled=false');
  });
  afterAll(async () => {
    if (!f) return;
    await f.sql.query('delete from public.photos where job_id=any($1::uuid[])', [madeJobs]);
    await f.sql.query('delete from public.jobs where id=any($1::uuid[])', [madeJobs]);
    await f.close();
  });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  async function job() {
    const id = randomUUID();
    expect((await f.admin.from('jobs').insert({ id, job_number: `reads-${id}`, name: 'Server reads fixture' })).error).toBeNull();
    madeJobs.push(id);
    return id;
  }
  /** A photo made `minutesAgo` minutes ago (created_at orders album covers). */
  async function photo(jobId: string, minutesAgo: number, thumb = true) {
    const id = randomUUID(); const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeA.id, kind: 'image',
      captured_at: at, created_at: at, original_path: `originals/${f.employeeA.id}/${id}/fixture.jpg`, original_name: 'fixture.jpg',
      thumb_path: thumb ? `derived/${f.employeeA.id}/${id}_thumb.webp` : null })).error).toBeNull();
    return id;
  }
  const trash = (id: string) =>
    f.sql.query("update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval '30 days' where id=$1", [id, f.employeeA.id]);
  const thumb = (id: string) => `derived/${f.employeeA.id}/${id}_thumb.webp`;

  describe('photo_actor_context: everything requirePhotoActor checks, in one read', () => {
    it('reports the profile, the Auth standing, and the gates', async () => {
      expect(await rpc('photo_actor_context', { p_actor: f.photoAdmin.id })).toEqual({
        has_profile: true, role: 'employee', profile_deleted: false, photo_admin: true, active: true,
        schema_generation: 1, photo_writes_enabled: true, mcp_enabled: false, repair_enabled: false,
      });
      expect(await rpc('photo_actor_context', { p_actor: f.administrator.id })).toMatchObject({ role: 'admin', photo_admin: false, active: true });
      expect(await rpc('photo_actor_context', { p_actor: randomUUID() })).toMatchObject({ has_profile: false, role: null, active: false, photo_writes_enabled: true });
    });

    it('agrees with photo_require_actor on a deactivated profile and a banned Auth user', async () => {
      await f.sql.query('update public.user_profiles set deleted_at=now() where user_id=$1', [f.employeeB.id]);
      try {
        expect(await rpc('photo_actor_context', { p_actor: f.employeeB.id })).toMatchObject({ profile_deleted: true, active: false });
      } finally {
        await f.sql.query('update public.user_profiles set deleted_at=null where user_id=$1', [f.employeeB.id]);
      }
      await f.sql.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [f.employeeB.id]);
      try {
        expect(await rpc('photo_actor_context', { p_actor: f.employeeB.id })).toMatchObject({ profile_deleted: false, active: false });
        expect((await f.admin.rpc('photo_require_actor', { p_actor: f.employeeB.id })).error?.message).toBe('invalid_actor');
      } finally {
        await f.sql.query('update auth.users set banned_until=null where id=$1', [f.employeeB.id]);
      }
      expect(await rpc('photo_actor_context', { p_actor: f.employeeB.id })).toMatchObject({ active: true });
    });

    it('is the server\'s alone: no browser session can call it', async () => {
      for (const client of [f.anon, f.employeeA.client, f.photoAdmin.client]) {
        expect((await client.rpc('photo_actor_context', { p_actor: f.employeeA.id })).error).not.toBeNull();
      }
    });
  });

  describe('get_photo_me: the caller\'s own permissions and settings, from their token', () => {
    it('answers for the signed-in person only, and nothing without a sign-in', async () => {
      await f.sql.query('update public.user_profiles set slideshow_shuffle=true,slideshow_delay_seconds=8 where user_id=$1', [f.employeeA.id]);
      try {
        const starter = (await f.sql.query('select starter_tags from public.photo_settings where singleton')).rows[0].starter_tags;
        expect((await f.employeeA.client.rpc('get_photo_me')).data).toEqual({ user_id: f.employeeA.id, photo_admin: false,
          slideshow_shuffle: true, slideshow_delay_seconds: 8, starter_tags: starter });
        expect((await f.photoAdmin.client.rpc('get_photo_me')).data).toMatchObject({ user_id: f.photoAdmin.id, photo_admin: true });
        expect((await f.anon.rpc('get_photo_me')).error).not.toBeNull();
        expect((await f.admin.rpc('get_photo_me')).data).toBeNull();
      } finally {
        await f.sql.query('update public.user_profiles set slideshow_shuffle=false,slideshow_delay_seconds=4 where user_id=$1', [f.employeeA.id]);
      }
    });

    it('says photo_admin false for a deactivated profile, and nothing for a banned Auth user', async () => {
      await f.sql.query('update public.user_profiles set deleted_at=now() where user_id=$1', [f.photoAdmin.id]);
      try {
        expect((await f.photoAdmin.client.rpc('get_photo_me')).data).toMatchObject({ photo_admin: false });
      } finally {
        await f.sql.query('update public.user_profiles set deleted_at=null where user_id=$1', [f.photoAdmin.id]);
      }
      await f.sql.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [f.employeeB.id]);
      try {
        expect((await f.employeeB.client.rpc('get_photo_me')).data).toBeNull();
      } finally {
        await f.sql.query('update auth.users set banned_until=null where id=$1', [f.employeeB.id]);
      }
    });
  });

  describe('get_photo_album_cards: one pass per album, with its maker and order', () => {
    it('counts active photos, keeps the 4 newest covers newest first, and reports the order', async () => {
      const project = await job(); const tag = `cards-${randomUUID()}`;
      const albumId = (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: `${tag} full` })).album.id as string;
      const emptyId = (await rpc('photo_create_album', { p_actor: f.employeeB.id, p_name: `${tag} empty` })).album.id as string;
      // Newest first: p0 .. p5; p1 goes to Trash, p3 has no thumbnail yet.
      const p = [];
      for (let i = 0; i < 6; i++) p.push(await photo(project, i + 1, i !== 3));
      await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: albumId, p_photo_ids: p });
      await trash(p[1]);

      const cards = async () => {
        const { data, error } = await f.employeeA.client.rpc('get_photo_album_cards', { q: tag });
        expect(error).toBeNull();
        return data as Array<Record<string, unknown>>;
      };
      const full = (await cards()).find(row => row.id === albumId)!;
      expect(full).toMatchObject({ name: `${tag} full`, photo_count: 5, thumbs: [thumb(p[0]), thumb(p[2]), thumb(p[4]), thumb(p[5])],
        created_by: f.employeeA.id, sort_mode: 'date', has_custom_order: false });
      expect(full.latest_added).toEqual(expect.any(String));
      expect((await cards()).find(row => row.id === emptyId)).toMatchObject({ photo_count: 0, thumbs: [], latest_added: null,
        created_by: f.employeeB.id, sort_mode: 'date', has_custom_order: false });

      // The old function keeps its six columns and agrees with the cards.
      const summaries = (await f.employeeA.client.rpc('get_photo_album_summaries', { q: tag })).data as Array<Record<string, unknown>>;
      expect(Object.keys(summaries.find(row => row.id === albumId)!).sort()).toEqual(['created_at', 'id', 'latest_added', 'name', 'photo_count', 'thumbs']);
      expect(summaries.find(row => row.id === albumId)).toMatchObject({ photo_count: 5, thumbs: full.thumbs });

      // Arranged: custom, and the saved order outlives a switch back to date order.
      await rpc('photo_album_reorder', { p_actor: f.employeeA.id, p_album: albumId, p_photo_ids: [p[5], p[4], p[3], p[2], p[0]] });
      expect((await cards()).find(row => row.id === albumId)).toMatchObject({ sort_mode: 'custom', has_custom_order: true });
      await rpc('photo_album_reorder', { p_actor: f.employeeA.id, p_album: albumId, p_photo_ids: null });
      expect((await cards()).find(row => row.id === albumId)).toMatchObject({ sort_mode: 'date', has_custom_order: true });

      // The page GET /api/photo-albums calls carries the new keys, so the route needs no second query.
      const page = (await f.employeeA.client.rpc('get_photo_album_summaries_by_name_page', { q: tag })).data as { rows: Array<Record<string, unknown>> };
      expect(page.rows.map(row => row.id)).toEqual([emptyId, albumId]);
      expect(page.rows[1]).toMatchObject({ created_by: f.employeeA.id, sort_mode: 'date', has_custom_order: true, photo_count: 5 });

      // A deleted album is not a card.
      await rpc('photo_delete_album', { p_actor: f.employeeB.id, p_album: emptyId });
      expect((await cards()).map(row => row.id)).toEqual([albumId]);
      expect((await f.anon.rpc('get_photo_album_cards', { q: tag })).error).not.toBeNull();
    });
  });

  describe('photo_favorite_photos: the reader\'s own favorites', () => {
    it('shows each person only their own favorites of active photos', async () => {
      const project = await job();
      const [a, b, gone] = [await photo(project, 1), await photo(project, 2), await photo(project, 3)];
      await rpc('photo_favorite', { p_actor: f.employeeA.id, p_photo_ids: [a, gone], p_on: true });
      await rpc('photo_favorite', { p_actor: f.employeeB.id, p_photo_ids: [b], p_on: true });
      await trash(gone);
      const seen = async (client: typeof f.admin) =>
        ((await client.from('photo_favorite_photos').select('id').eq('job_id', project).is('deleted_at', null)).data ?? []).map(row => row.id);
      expect(await seen(f.employeeA.client)).toEqual([a]);
      expect(await seen(f.employeeB.client)).toEqual([b]);
      // The service role has no "me": it sees none.
      expect(await seen(f.admin)).toEqual([]);
      expect((await f.anon.from('photo_favorite_photos').select('id').limit(1)).error).not.toBeNull();
      // The favorites row rule, rewritten, still shows only the reader's own rows.
      expect(((await f.employeeA.client.from('photo_favorites').select('photo_id').in('photo_id', [a, b, gone])).data ?? [])
        .map(row => row.photo_id).sort()).toEqual([a, gone].sort());
    });
  });
});
