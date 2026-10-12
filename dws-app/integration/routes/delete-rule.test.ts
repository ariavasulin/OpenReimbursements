import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';

vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return {
    cookies: async () => ({
      get: (name: string) => { const value = requestContext.getStore()!.cookies.get(name); return value === undefined ? undefined : { name, value }; },
      getAll: () => [...requestContext.getStore()!.cookies].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); },
    }),
    headers: async () => requestContext.getStore()!.headers,
  };
});

import { GET as actorRoute } from '@/app/api/photos/actor/route';
import { GET as ownership } from '@/app/api/photos/[id]/ownership/route';
import { DELETE as trashPhoto } from '@/app/api/photos/[id]/route';
import { GET as getAlbum, DELETE as deleteAlbum } from '@/app/api/photo-albums/[id]/route';
import { GET as listAlbums } from '@/app/api/photo-albums/route';
import { GET as getUser, PATCH as patchUser } from '@/app/api/admin/users/[id]/route';
import { GET as listUsers } from '@/app/api/admin/users/route';

// Through the real routes: who is a photo admin, what the screens are told, and that each delete
// route answers 403 to anyone the rule refuses.
describe('photo admins and the delete rule, through the routes', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const call = async (handler: Handler, method: string, path: string, actor: FixtureActor, body?: unknown, id = '') => {
    const request = new Request(`${origin}${path}`, { method,
      headers: body === undefined ? { origin } : { origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await withRequest(request, actor.cookies, () => handler(request, { params: Promise.resolve({ id }) }));
    return { status: response.status, body: await response.json() };
  };
  const day = 86_400_000;
  async function photo(uploader: string, daysAgo: number) {
    const id = randomUUID(); const now = Date.now();
    const inserted = await f.admin.from('photos').insert({ id, job_id: null, uploader_id: uploader, kind: 'image',
      captured_at: new Date(now).toISOString(), created_at: new Date(now - daysAgo * day).toISOString(),
      original_path: `originals/${uploader}/${id}/rule.jpg`, original_name: 'rule.jpg' });
    expect(inserted.error).toBeNull();
    return id;
  }
  const isTrashed = async (id: string) => (await f.sql.query('select deleted_at from public.photos where id=$1', [id])).rows[0].deleted_at !== null;

  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true })).error).toBeNull();
  });
  afterAll(async () => { await f?.close(); });

  it('AC-4: a Receipts admin ticks Photo admin and GET /api/photos/actor reports it on the next request', async () => {
    const before = await call(actorRoute, 'GET', '/api/photos/actor', f.employeeB);
    expect(before).toEqual({ status: 200, body: { user_id: f.employeeB.id, photo_admin: false } });
    try {
      const ticked = await call(patchUser, 'PATCH', `/api/admin/users/${f.employeeB.id}`, f.administrator, { photo_admin: true }, f.employeeB.id);
      expect(ticked).toMatchObject({ status: 200, body: { user: { id: f.employeeB.id, photo_admin: true, role: 'employee' } } });
      expect((await call(actorRoute, 'GET', '/api/photos/actor', f.employeeB)).body).toEqual({ user_id: f.employeeB.id, photo_admin: true });
      expect((await call(getUser, 'GET', `/api/admin/users/${f.employeeB.id}`, f.administrator, undefined, f.employeeB.id)).body.user.photo_admin).toBe(true);
      const listed = await call(listUsers, 'GET', '/api/admin/users?perPage=1000', f.administrator);
      expect(listed.body.users.find((user: { id: string }) => user.id === f.employeeB.id)?.photo_admin).toBe(true);
      // The change is live for deleting too: employee B may now trash a colleague's photo.
      const theirs = await photo(f.employeeA.id, 90);
      expect((await call(ownership, 'GET', `/api/photos/${theirs}/ownership`, f.employeeB, undefined, theirs)).body.can_trash).toBe(true);
    } finally {
      expect((await call(patchUser, 'PATCH', `/api/admin/users/${f.employeeB.id}`, f.administrator, { photo_admin: false }, f.employeeB.id)).status).toBe(200);
    }
    expect((await call(actorRoute, 'GET', '/api/photos/actor', f.employeeB)).body.photo_admin).toBe(false);
    // Only a Receipts admin may set it, and only to true or false; the Receipts role is a separate thing.
    expect((await call(patchUser, 'PATCH', `/api/admin/users/${f.employeeB.id}`, f.employeeA, { photo_admin: true }, f.employeeB.id)).status).toBe(403);
    expect((await call(patchUser, 'PATCH', `/api/admin/users/${f.employeeB.id}`, f.administrator, { photo_admin: 'yes' }, f.employeeB.id)).status).toBe(400);
    expect((await call(actorRoute, 'GET', '/api/photos/actor', f.administrator)).body.photo_admin).toBe(false);
    expect((await call(actorRoute, 'GET', '/api/photos/actor', f.photoAdmin)).body).toEqual({ user_id: f.photoAdmin.id, photo_admin: true });
  });

  it('AC-2: ownership reports the real can_trash, and the one-photo trash route obeys it', async () => {
    const [recent, old, theirs] = await Promise.all([photo(f.employeeA.id, 29), photo(f.employeeA.id, 31), photo(f.employeeB.id, 1)]);
    const canTrash = async (id: string, actor: FixtureActor) =>
      (await call(ownership, 'GET', `/api/photos/${id}/ownership`, actor, undefined, id)).body.can_trash;
    expect(await Promise.all([recent, old, theirs].map(id => canTrash(id, f.employeeA)))).toEqual([true, false, false]);
    expect(await canTrash(theirs, f.photoAdmin)).toBe(true);
    for (const id of [old, theirs]) {
      expect(await call(trashPhoto, 'DELETE', `/api/photos/${id}`, f.employeeA, undefined, id)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
      expect(await isTrashed(id)).toBe(false);
    }
    expect((await call(trashPhoto, 'DELETE', `/api/photos/${recent}`, f.employeeA, undefined, recent)).status).toBe(200);
    expect((await call(trashPhoto, 'DELETE', `/api/photos/${theirs}`, f.photoAdmin, undefined, theirs)).status).toBe(200);
    expect([await isTrashed(recent), await isTrashed(theirs)]).toEqual([true, true]);
  });

  it('AC-1/AC-3: an album is deleted by its maker or a photo admin, and the album routes say who made it', async () => {
    const made = async (actor: FixtureActor) => (await f.admin.rpc('photo_create_album', { p_actor: actor.id, p_name: `Rule ${randomUUID().slice(0, 6)}` })).data.album.id as string;
    const [mine, theirs] = await Promise.all([made(f.employeeA), made(f.employeeB)]);
    expect((await call(getAlbum, 'GET', `/api/photo-albums/${theirs}`, f.employeeA, undefined, theirs)).body.album.created_by).toBe(f.employeeB.id);
    const cards = (await call(listAlbums, 'GET', '/api/photo-albums', f.employeeA)).body.albums as Array<{ id: string; created_by: string }>;
    expect(cards.find(card => card.id === theirs)?.created_by).toBe(f.employeeB.id);
    expect(await call(deleteAlbum, 'DELETE', `/api/photo-albums/${theirs}`, f.employeeA, undefined, theirs)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect((await call(deleteAlbum, 'DELETE', `/api/photo-albums/${mine}`, f.employeeA, undefined, mine)).status).toBe(200);
    expect((await call(deleteAlbum, 'DELETE', `/api/photo-albums/${theirs}`, f.photoAdmin, undefined, theirs)).status).toBe(200);
  });
});
