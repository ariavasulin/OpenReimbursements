import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';

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

import { GET as oneAlbum } from '@/app/api/photo-albums/[id]/route';
import { PATCH as patchOrder } from '@/app/api/photo-albums/[id]/order/route';
import { POST as addPhotos } from '@/app/api/photo-albums/[id]/photos/route';
import { GET as listPhotos } from '@/app/api/photos/route';
import { GET as listIds } from '@/app/api/photos/ids/route';
import { GET as publicRead } from '@/app/api/share/[token]/route';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-E (AC-16) through the real route
// handlers: PATCH /api/photo-albums/[id]/order, the album's sort_mode, GET /api/photos and /ids with
// `album=…&sort=custom` across a page boundary, and the public share read in custom order.
type Context = { params: Promise<{ id: string }> };
type Handler = (request: Request, context: Context) => Promise<Response>;

describe('album custom order routes (W2-E: AC-16)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const madePhotos: string[] = [];
  const madeAlbums: string[] = [];
  let clock = Date.UTC(2031, 5, 1);

  beforeAll(async () => { f = await createFixtures(); });
  beforeEach(async () => {
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true, sharing_enabled: true })).error).toBeNull();
  });
  afterAll(async () => {
    if (!f) return;
    await f.sql.query('update public.photo_release_state set sharing_enabled=false');
    await f.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
    await f.sql.query('delete from public.photo_share_links where album_id=any($1::uuid[])', [madeAlbums]);
    await f.sql.query('delete from public.albums where id=any($1::uuid[])', [madeAlbums]);
    await f.close();
  });

  async function call(handler: Handler | ((request: Request) => Promise<Response>), path: string,
    options: { method?: string; body?: unknown; actor?: FixtureActor | null; id?: string } = {}) {
    const method = options.method ?? 'GET';
    const request = new Request(`${origin}${path}`, { method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: origin },
      ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    const cookies = options.actor === null ? [] : (options.actor ?? f.employeeA).cookies;
    return withRequest(request, cookies, () => (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '' }) }));
  }
  async function json(response: Response, status = 200) {
    const body = await response.json();
    expect(response.status, JSON.stringify(body).slice(0, 500)).toBe(status);
    return body;
  }
  async function album() {
    const { data, error } = await f.admin.rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: 'Presentation' });
    expect(error).toBeNull();
    madeAlbums.push(data.album.id);
    return data.album.id as string;
  }
  /** `count` photos in `albumId`, one minute apart, so date order is newest-created first. */
  async function filled(albumId: string, count: number) {
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const id = randomUUID(); clock += 60_000;
      expect((await f.admin.from('photos').insert({ id, job_id: null, uploader_id: f.employeeB.id, kind: 'image',
        captured_at: new Date(clock).toISOString(), original_name: 'fixture.jpg', mime_type: 'image/jpeg',
        original_path: `originals/${f.employeeB.id}/${id}/fixture.jpg`, thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`,
        preview_path: `derived/${f.employeeB.id}/${id}_preview.webp` })).error).toBeNull();
      madePhotos.push(id); ids.push(id);
    }
    await json(await call(addPhotos, `/api/photo-albums/${albumId}/photos`, { method: 'POST', id: albumId, body: { photo_ids: ids } }));
    return ids;
  }
  const order = (albumId: string, body: unknown, actor?: FixtureActor) =>
    call(patchOrder, `/api/photo-albums/${albumId}/order`, { method: 'PATCH', id: albumId, body, actor });
  const detail = async (albumId: string) => (await json(await call(oneAlbum, `/api/photo-albums/${albumId}`, { id: albumId }))).album;
  /** Every page of GET /api/photos for `query`, `limit` at a time. */
  async function walk(query: string, limit: number) {
    const seen: string[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const page = await json(await call(listPhotos, `/api/photos?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`));
      for (const row of page.photos) {
        expect(row).not.toHaveProperty('album_position'); expect(row).not.toHaveProperty('albums');
        seen.push(row.id);
      }
      cursor = page.nextCursor; pages++;
    } while (cursor && pages < 20);
    return { seen, pages };
  }

  it('Arrange saves the order for every employee; GET /api/photos and /ids page it in that order', async () => {
    const a = await album(); const ids = await filled(a, 5);
    expect(await detail(a)).toMatchObject({ sort_mode: 'date', has_custom_order: false, photo_count: 5 });
    const arranged = [ids[2], ids[0], ids[4], ids[1], ids[3]];
    // Arranging is open to every employee, not just the album's creator.
    expect(await json(await order(a, { photo_ids: arranged }, f.employeeB))).toEqual({ sort_mode: 'custom', arranged: 5 });
    expect(await detail(a)).toMatchObject({ sort_mode: 'custom', has_custom_order: true });

    // Two per page: three pages, nothing repeated or skipped across the boundaries.
    const custom = await walk(`album=${a}&sort=custom`, 2);
    expect(custom).toEqual({ seen: arranged, pages: 3 });
    expect((await call(listPhotos, `/api/photos?album=${a}&sort=custom&limit=2`, { actor: f.employeeB }).then(json)).photos.map((row: { id: string }) => row.id))
      .toEqual(arranged.slice(0, 2));
    expect(await json(await call(listIds, `/api/photos/ids?album=${a}&sort=custom`))).toEqual({ ids: arranged, total: 5, truncated: false });
    // The filters still apply in custom order.
    expect((await walk(`album=${a}&sort=custom&from=${new Date(clock - 90_000).toISOString()}`, 2)).seen).toEqual([ids[4], ids[3]]);
    // Date order is untouched.
    expect((await walk(`album=${a}`, 2)).seen).toEqual([...ids].reverse());
  });

  it('a cursor only continues the order it came from; sort=custom needs an album', async () => {
    const a = await album(); const ids = await filled(a, 3);
    await json(await order(a, { photo_ids: [ids[1], ids[2], ids[0]] }));
    const custom = await json(await call(listPhotos, `/api/photos?album=${a}&sort=custom&limit=1`));
    const dated = await json(await call(listPhotos, `/api/photos?album=${a}&limit=1`));
    expect(Buffer.from(custom.nextCursor, 'base64url').toString()).toMatch(/^\["position:1","/);
    await json(await call(listPhotos, `/api/photos?album=${a}&limit=1&cursor=${custom.nextCursor}`), 400);
    await json(await call(listPhotos, `/api/photos?album=${a}&sort=custom&limit=1&cursor=${dated.nextCursor}`), 400);
    await json(await call(listPhotos, `/api/photos?album=${a}&sort=asc&limit=1&cursor=${custom.nextCursor}`), 400);
    expect((await json(await call(listPhotos, '/api/photos?sort=custom'), 400)).error.message).toMatch(/album/);
    await json(await call(listIds, '/api/photos/ids?sort=custom'), 400);
    await json(await call(listPhotos, `/api/photos?album=${a}&sort=custom`, { actor: null }), 401);
  });

  it('{sort_mode:"date"} goes back to newest first and keeps the order; saving it again restores it; added photos land last', async () => {
    const a = await album(); const ids = await filled(a, 3);
    const arranged = [ids[2], ids[0], ids[1]];
    await json(await order(a, { photo_ids: arranged }));
    const [added] = await filled(a, 1);
    expect((await walk(`album=${a}&sort=custom`, 2)).seen).toEqual([...arranged, added]);

    expect(await json(await order(a, { sort_mode: 'date' }))).toEqual({ sort_mode: 'date' });
    expect(await detail(a)).toMatchObject({ sort_mode: 'date', has_custom_order: true });
    const saved = (await json(await call(listIds, `/api/photos/ids?album=${a}&sort=custom`))).ids;
    expect(saved).toEqual([...arranged, added]);
    await json(await order(a, { photo_ids: saved }));
    expect(await detail(a)).toMatchObject({ sort_mode: 'custom' });
    expect((await walk(`album=${a}&sort=custom`, 3)).seen).toEqual([...arranged, added]);
  });

  it('refuses a malformed or partial order', async () => {
    const a = await album(); const ids = await filled(a, 3);
    for (const body of [{}, { photo_ids: [] }, { photo_ids: 'all' }, { photo_ids: [ids[0], 'nope', ids[2]] }, { sort_mode: 'custom' },
      { sort_mode: 'date', photo_ids: ids }, { photo_ids: ids, extra: true }, { photo_ids: ids.slice(0, 2) },
      { photo_ids: Array.from({ length: 2001 }, () => randomUUID()) }]) {
      await json(await order(a, body), 400);
    }
    await json(await order(randomUUID(), { photo_ids: ids }), 404);
    await json(await order(a, { photo_ids: ids }, null as unknown as FixtureActor), 401);
    expect(await detail(a)).toMatchObject({ sort_mode: 'date', has_custom_order: false });
  });

  it('the public share page follows the custom order, and date order again after the switch back', async () => {
    const a = await album(); const ids = await filled(a, 4);
    const arranged = [ids[3], ids[1], ids[0], ids[2]];
    await json(await order(a, { photo_ids: arranged }));
    const { data, error } = await f.admin.rpc('photo_share_set', { p_actor: f.employeeA.id, p_album: a, p_job: null, p_enabled: true });
    expect(error).toBeNull();
    const token = data.token as string;
    const visit = async (query = '') => {
      const response = await publicRead(new Request(`${origin}/api/share/${token}${query}`), { params: Promise.resolve({ token }) });
      return json(response);
    };
    const seen: string[] = [];
    let page = await visit();
    expect(page).toMatchObject({ kind: 'album', count: 4 });
    seen.push(...page.photos.map((row: { id: string }) => row.id));
    expect(seen).toEqual(arranged);
    await json(await order(a, { sort_mode: 'date' }));
    page = await visit();
    expect(page.photos.map((row: { id: string }) => row.id)).toEqual([...ids].reverse());
  });
});
