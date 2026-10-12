import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-E (AC-16) at the database:
// photo_album_reorder, the append trigger, the album_photo_order view, and photo_share_read in
// custom order. Every scenario owns its album and photos; afterAll removes them.
type Shared = { kind: string; count: number; photos: Array<{ id: string }>; next_after: Record<string, unknown> | null } | null;

describe('album custom order (W2-E: AC-16)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const madePhotos: string[] = [];
  const madeAlbums: string[] = [];
  // Capture times run forward, so date order (newest first) is the reverse of creation order.
  let clock = Date.UTC(2031, 2, 1);

  beforeAll(async () => { f = await createFixtures(); });
  beforeEach(async () => { await f.sql.query('update public.photo_release_state set photo_writes_enabled=true,sharing_enabled=true'); });
  afterAll(async () => {
    if (!f) return;
    await f.sql.query('update public.photo_release_state set sharing_enabled=false');
    await f.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
    await f.sql.query('delete from public.photo_share_links where album_id=any($1::uuid[])', [madeAlbums]);
    await f.sql.query('delete from public.albums where id=any($1::uuid[])', [madeAlbums]);
    await f.close();
  });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) => (await f.admin.rpc(name, args)).error?.message;
  async function album() {
    const id = (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: 'Arranged album' })).album.id as string;
    madeAlbums.push(id);
    return id;
  }
  async function photo(options: { trashed?: boolean } = {}) {
    const id = randomUUID(); clock += 60_000; const at = new Date(clock).toISOString();
    expect((await f.admin.from('photos').insert({ id, job_id: null, uploader_id: f.employeeB.id, kind: 'image', captured_at: at,
      original_name: 'fixture.jpg', mime_type: 'image/jpeg', original_path: `originals/${f.employeeB.id}/${id}/fixture.jpg`,
      thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`,
      ...(options.trashed ? { deleted_at: at, deleted_by: f.employeeB.id, purge_after: new Date(clock + 30 * 86_400_000).toISOString() } : {}) })).error).toBeNull();
    madePhotos.push(id);
    return id;
  }
  /** `count` photos, added to `albumId` through photo_album_add in creation order. */
  async function filled(albumId: string, count: number) {
    const ids: string[] = [];
    for (let n = 0; n < count; n++) ids.push(await photo());
    expect(await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: albumId, p_photo_ids: ids })).toMatchObject({ added: count });
    return ids;
  }
  const reorder = (albumId: string, ids: string[] | null) => rpc('photo_album_reorder', { p_actor: f.employeeB.id, p_album: albumId, p_photo_ids: ids });
  const mode = async (albumId: string) => (await f.sql.query('select sort_mode from public.albums where id=$1', [albumId])).rows[0].sort_mode as string;
  /** The album as an employee reads it in custom order (the view GET /api/photos uses). */
  async function viewOrder(albumId: string) {
    const { data, error } = await f.employeeA.client.from('album_photo_order').select('id').eq('album_id', albumId)
      .order('album_position', { ascending: true }).order('id', { ascending: true });
    expect(error).toBeNull();
    return (data ?? []).map(row => row.id as string);
  }
  async function shareToken(albumId: string) {
    return (await rpc('photo_share_set', { p_actor: f.employeeA.id, p_album: albumId, p_job: null, p_enabled: true })).token as string;
  }
  const read = (token: string, after: unknown = null, limit = 100) =>
    rpc('photo_share_read', { p_token: token, p_after: after, p_limit: limit }) as Promise<Shared>;
  /** Every page of a share link, following next_after. */
  async function readAll(token: string, limit: number) {
    const seen: string[] = []; let after: unknown = null;
    for (let page = 0; page < 20; page++) {
      const shared = await read(token, after, limit);
      seen.push(...shared!.photos.map(row => row.id));
      if (!shared!.next_after) return seen;
      after = shared!.next_after;
    }
    throw new Error('share pages never ended');
  }

  it('a new album is in date order with no positions; the columns are additive', async () => {
    const a = await album(); await filled(a, 2);
    expect(await mode(a)).toBe('date');
    expect((await f.sql.query('select count(*)::int as n from public.album_photos where album_id=$1 and position is not null', [a])).rows[0].n).toBe(0);
    expect((await f.sql.query("select is_nullable,data_type from information_schema.columns where table_name='album_photos' and column_name='position'")).rows)
      .toEqual([{ is_nullable: 'YES', data_type: 'double precision' }]);
    await expect(f.sql.query("update public.albums set sort_mode='manual' where id=$1", [a])).rejects.toThrow(/albums_sort_mode_check/);
  });

  it('reorder saves the full order for everyone, the share link follows it, and an add lands last', async () => {
    const a = await album(); const [p1, p2, p3, p4] = await filled(a, 4);
    const token = await shareToken(a);
    expect((await read(token))!.photos.map(row => row.id)).toEqual([p4, p3, p2, p1]);

    const arranged = [p3, p1, p4, p2];
    expect(await reorder(a, arranged)).toEqual({ sort_mode: 'custom', arranged: 4 });
    expect(await mode(a)).toBe('custom');
    expect((await f.sql.query('select photo_id,position from public.album_photos where album_id=$1 order by position', [a])).rows)
      .toEqual(arranged.map((photo_id, index) => ({ photo_id, position: index + 1 })));
    // One order everyone sees: another employee's read, and the share link.
    expect(await viewOrder(a)).toEqual(arranged);
    const shared = await read(token);
    expect(shared).toMatchObject({ kind: 'album', count: 4, next_after: null });
    expect(shared!.photos.map(row => row.id)).toEqual(arranged);

    // photo_album_add appends max+1; a photo joining through any other path (an upload into the
    // album writes album_photos directly) appends the same way.
    const added = await photo();
    await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [added] });
    const uploaded = await photo();
    await f.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [a, uploaded, f.employeeA.id]);
    expect((await f.sql.query('select position from public.album_photos where album_id=$1 and photo_id=any($2::uuid[]) order by position', [a, [added, uploaded]])).rows)
      .toEqual([{ position: 5 }, { position: 6 }]);
    expect(await viewOrder(a)).toEqual([...arranged, added, uploaded]);
    expect((await read(token))!.photos.map(row => row.id)).toEqual([...arranged, added, uploaded]);
  });

  it('switching to date keeps the positions; switching back restores the saved order, with photos added meanwhile last', async () => {
    const a = await album(); const [p1, p2, p3] = await filled(a, 3);
    const token = await shareToken(a);
    await reorder(a, [p2, p3, p1]);
    expect(await reorder(a, null)).toEqual({ sort_mode: 'date' });
    expect(await mode(a)).toBe('date');
    expect((await read(token))!.photos.map(row => row.id)).toEqual([p3, p2, p1]);
    // In date order an added photo gets no position.
    const later = await photo();
    await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [later] });
    expect((await f.sql.query('select position from public.album_photos where album_id=$1 and photo_id=$2', [a, later])).rows[0].position).toBeNull();
    // The custom order is still readable, positionless photos last; saving it again restores it.
    const saved = await viewOrder(a);
    expect(saved).toEqual([p2, p3, p1, later]);
    await reorder(a, saved);
    expect(await mode(a)).toBe('custom');
    expect((await read(token))!.photos.map(row => row.id)).toEqual([p2, p3, p1, later]);
    // Repeating the date switch is harmless.
    await reorder(a, null); await reorder(a, null);
    expect(await mode(a)).toBe('date');
  });

  it('a list that is not exactly the active membership raises invalid_input and changes nothing', async () => {
    const a = await album(); const [p1, p2, p3] = await filled(a, 3);
    const gone = await photo();
    await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [gone] });
    await f.sql.query('update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval \'30 days\' where id=$1', [gone, f.employeeB.id]);
    const outsider = await photo();
    for (const [label, ids] of [
      ['one missing', [p1, p2]],
      ['a photo not in the album', [p1, p2, p3, outsider]],
      ['a photo swapped for an outsider', [p1, p2, outsider]],
      ['a repeat', [p1, p2, p3, p3]],
      ['a repeat hiding a missing one', [p1, p2, p2]],
      ['a trashed member', [p1, p2, p3, gone]],
      ['empty', []],
    ] as const) {
      expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: ids }), label).toBe('invalid_input');
    }
    expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [p1, null, p3] })).toBe('invalid_input');
    expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a,
      p_photo_ids: Array.from({ length: 2001 }, () => randomUUID()) })).toBe('invalid_input');
    expect(await mode(a)).toBe('date');
    expect((await f.sql.query('select count(*)::int as n from public.album_photos where album_id=$1 and position is not null', [a])).rows[0].n).toBe(0);
    expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: randomUUID(), p_photo_ids: [p1] })).toBe('not_found');
    await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: a });
    expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [p1, p2, p3] })).toBe('not_found');
    expect(await refused('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: null })).toBe('not_found');
  });

  it('a trashed member keeps a place after the arranged ones, so a restore brings it back last', async () => {
    const a = await album(); const [p1, p2, p3] = await filled(a, 3);
    await reorder(a, [p3, p2, p1]);
    await f.sql.query('update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval \'30 days\' where id=$1', [p2, f.employeeB.id]);
    await reorder(a, [p1, p3]);
    await f.sql.query('update public.photos set deleted_at=null,deleted_by=null,purge_after=null where id=$1', [p2]);
    expect(await viewOrder(a)).toEqual([p1, p3, p2]);
  });

  it('the share link pages custom order across a page boundary, and a date cursor reads as nothing there', async () => {
    const a = await album(); const ids = await filled(a, 5);
    const arranged = [ids[2], ids[4], ids[0], ids[3], ids[1]];
    await reorder(a, arranged);
    const token = await shareToken(a);
    const first = await read(token, null, 2);
    expect(first!.photos.map(row => row.id)).toEqual(arranged.slice(0, 2));
    expect(first!.next_after).toEqual({ position: 2, id: arranged[1] });
    expect(await readAll(token, 2)).toEqual(arranged);
    // A photo with no position (added in date order) pages after the positioned ones.
    await reorder(a, null);
    const late = await photo();
    await rpc('photo_album_add', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [late] });
    await f.sql.query("update public.albums set sort_mode='custom' where id=$1", [a]);
    expect(await readAll(token, 2)).toEqual([...arranged, late]);
    expect(await readAll(token, 5)).toEqual([...arranged, late]);
    // The other shape of cursor is not one this album handed out.
    expect(await read(token, { captured_at: new Date().toISOString(), id: arranged[0] }, 2)).toBeNull();
    expect(await read(token, { position: 'soon', id: arranged[0] }, 2)).toBeNull();
    // And a date-order album refuses a position cursor.
    await reorder(a, null);
    expect(await read(token, { position: 2, id: arranged[1] }, 2)).toBeNull();
    expect((await read(token, null, 2))!.next_after).toHaveProperty('captured_at');
  });

  it('only the service role may call photo_album_reorder; the view is for signed-in reads only', async () => {
    const a = await album(); const [p1] = await filled(a, 1);
    for (const client of [f.anon, f.employeeA.client]) {
      expect((await client.rpc('photo_album_reorder', { p_actor: f.employeeA.id, p_album: a, p_photo_ids: [p1] })).error).not.toBeNull();
    }
    expect((await f.anon.from('album_photo_order').select('id').eq('album_id', a)).error).not.toBeNull();
    expect((await f.sql.query("select count(*)::int as n from pg_proc where proname='photo_album_append_position' and has_function_privilege('service_role',oid,'execute')")).rows[0].n).toBe(0);
    // A deleted album lists nothing through the view, as through the album filter.
    await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: a });
    expect(await viewOrder(a)).toEqual([]);
  });
});
