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

import { POST as bulk } from '@/app/api/photos/bulk/route';
import { POST as rows } from '@/app/api/photos/rows/route';
import { MAX_ACTION_RUN_PHOTOS } from '@/lib/photos/chunks';

// POST /api/photos/bulk: Trash (and its Undo) for a whole slice of a selection in
// one request, through the same SQL batch functions as the confirm page. And
// POST /api/photos/rows: the zip fields of selected photos the grid has not loaded.
describe('bulk trash and restore, and the zip row lookup, through the routes', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const day = 86_400_000;
  const call = async (actor: FixtureActor, body: unknown, headers: Record<string, string> = { origin }, route = bulk, path = 'bulk') => {
    const request = new Request(`${origin}/api/photos/${path}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const response = await withRequest(request, actor.cookies, () => route(request));
    return { status: response.status, body: await response.json() };
  };
  /** `count` photos uploaded by `uploader` `daysAgo` days ago, inserted in one go. */
  async function photos(uploader: string, count: number, daysAgo = 1, extra: Record<string, unknown> = {}) {
    const now = Date.now();
    // A second apart, so each gets its own automatic name without the numbering scan.
    const rows = Array.from({ length: count }, (_, index) => {
      const id = randomUUID();
      return { id, job_id: null, uploader_id: uploader, kind: 'image', captured_at: new Date(now - index * 1000).toISOString(),
        created_at: new Date(now - daysAgo * day).toISOString(), original_path: `originals/${uploader}/${id}/bulk.jpg`,
        original_name: 'bulk.jpg', ...extra };
    });
    for (let start = 0; start < rows.length; start += 200) {
      expect((await f.admin.from('photos').insert(rows.slice(start, start + 200))).error).toBeNull();
    }
    return rows.map(row => row.id);
  }
  const trashed = async (ids: string[]) =>
    (await f.sql.query('select count(*)::int as n from public.photos where id = any($1) and deleted_at is not null', [ids])).rows[0].n as number;

  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true })).error).toBeNull();
  });
  afterAll(async () => { await f?.close(); });

  it('trashes what the rule allows, leaves out and counts the rest, records one batch, and Undo restores exactly those', async () => {
    const mine = await photos(f.employeeA.id, 2);
    const [old] = await photos(f.employeeA.id, 1, 31);
    const [theirs] = await photos(f.employeeB.id, 1);
    const at = Date.now();
    const [already] = await photos(f.employeeA.id, 1, 1, {
      deleted_at: new Date(at).toISOString(), deleted_by: f.employeeA.id, purge_after: new Date(at + 30 * day).toISOString(),
    });
    const gone = randomUUID();
    const sent = [mine[0], old, theirs, gone, already, mine[1], mine[0]];

    const result = await call(f.employeeA, { action: 'trash', photo_ids: sent });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ left_out: 3, failed: 0 });
    expect([...result.body.photo_ids].sort()).toEqual([...mine].sort());
    expect(await trashed(mine)).toBe(2);
    expect(await trashed([old, theirs])).toBe(0);

    // The audit trail is the confirm page's: one completed trash batch holding the two.
    const batch = await f.sql.query('select action, status, origin, created_by, approved_by from public.photo_action_batches where id = $1', [result.body.batch_id]);
    expect(batch.rows[0]).toEqual({ action: 'trash', status: 'completed', origin: 'ordinary', created_by: f.employeeA.id, approved_by: f.employeeA.id });
    const items = await f.sql.query('select photo_id, status from public.photo_action_items where batch_id = $1 order by photo_id', [result.body.batch_id]);
    expect(items.rows).toEqual([...mine].sort().map(photo_id => ({ photo_id, status: 'applied' })));

    const undo = await call(f.employeeA, { action: 'restore', photo_ids: result.body.photo_ids });
    expect(undo).toMatchObject({ status: 200, body: { left_out: 0, failed: 0 } });
    expect([...undo.body.photo_ids].sort()).toEqual([...mine].sort());
    expect(await trashed(mine)).toBe(0);
    // The photo that was already in Trash stays there: this Undo never had it.
    expect(await trashed([already])).toBe(1);
  });

  it('a photo admin may trash anyone’s photo; nothing usable makes no batch', async () => {
    const [theirs] = await photos(f.employeeB.id, 1, 90);
    expect(await call(f.employeeA, { action: 'trash', photo_ids: [theirs] })).toEqual({
      status: 200, body: { batch_id: null, photo_ids: [], left_out: 1, failed: 0 },
    });
    expect((await call(f.photoAdmin, { action: 'trash', photo_ids: [theirs] })).body).toMatchObject({ photo_ids: [theirs], left_out: 0 });
    expect(await trashed([theirs])).toBe(1);
  });

  it(`takes the largest slice (${MAX_ACTION_RUN_PHOTOS} photos) in one request, and refuses more, other actions, and other sites`, async () => {
    const ids = await photos(f.employeeA.id, MAX_ACTION_RUN_PHOTOS);
    const result = await call(f.employeeA, { action: 'trash', photo_ids: ids });
    expect(result.status).toBe(200);
    expect(result.body.photo_ids).toHaveLength(MAX_ACTION_RUN_PHOTOS);
    expect(result.body).toMatchObject({ left_out: 0, failed: 0 });
    expect(await trashed(ids)).toBe(MAX_ACTION_RUN_PHOTOS);

    expect((await call(f.employeeA, { action: 'trash', photo_ids: [...ids, randomUUID()] })).status).toBe(400);
    expect((await call(f.employeeA, { action: 'move', photo_ids: ids.slice(0, 1) })).status).toBe(400);
    expect((await call(f.employeeA, { action: 'trash', photo_ids: ['not-a-uuid'] })).status).toBe(400);
    expect((await call(f.employeeA, { action: 'trash', photo_ids: [] })).status).toBe(400);
    expect((await call(f.employeeA, { action: 'restore', photo_ids: ids.slice(0, 1) }, { origin: 'https://elsewhere.example' })).status).toBe(403);
  });

  it('looks up the zip fields of up to 500 photos by id, leaving out trashed and unknown ones', async () => {
    const lookup = (actor: FixtureActor, body: unknown) => call(actor, body, { origin }, rows, 'rows');
    const [active, other] = await photos(f.employeeB.id, 2);
    const at = Date.now();
    const [binned] = await photos(f.employeeA.id, 1, 1, {
      deleted_at: new Date(at).toISOString(), deleted_by: f.employeeA.id, purge_after: new Date(at + 30 * day).toISOString(),
    });
    const found = await lookup(f.employeeA, { photo_ids: [active, binned, randomUUID(), other, active] });
    expect(found.status).toBe(200);
    expect(found.body.photos.map((photo: { id: string }) => photo.id).sort()).toEqual([active, other].sort());
    expect(Object.keys(found.body.photos[0]).sort()).toEqual(['captured_at', 'display_name', 'id', 'original_bytes', 'original_name', 'original_path']);

    const many = await photos(f.employeeA.id, 500);
    expect((await lookup(f.employeeA, { photo_ids: many })).body.photos).toHaveLength(500);
    expect((await lookup(f.employeeA, { photo_ids: [...many, active] })).status).toBe(400);
    expect((await lookup(f.employeeA, { photo_ids: [active], fields: 'all' })).status).toBe(400);
    const anonymous = new Request(`${origin}/api/photos/rows`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ photo_ids: [active] }) });
    expect((await withRequest(anonymous, [], () => rows(anonymous))).status).toBe(401);
  });
});
