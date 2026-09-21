import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

import { GET as listAlbums, POST as createAlbum } from '@/app/api/photo-albums/route';
import { PATCH as patchAlbum, DELETE as deleteAlbum } from '@/app/api/photo-albums/[id]/route';
import { POST as addPhotos, DELETE as removePhotos } from '@/app/api/photo-albums/[id]/photos/route';
import { POST as bulkTag } from '@/app/api/photos/tags/route';
import { GET as listPhotos, POST as finalize } from '@/app/api/photos/route';
import { GET as onePhoto } from '@/app/api/photos/[id]/route';
import { POST as attempt } from '@/app/api/photo-migrations/uploads/attempt/route';
import { POST as acquire } from '@/app/api/photo-migrations/uploads/acquire/route';
import { POST as claim } from '@/app/api/photo-migrations/uploads/claim/route';
import { POST as createBatch } from '@/app/api/photo-actions/batches/route';
import { POST as materialize } from '@/app/api/photo-actions/batches/[id]/materialize/route';
import { POST as approve } from '@/app/api/photo-actions/batches/[id]/approve/route';
import { POST as apply } from '@/app/api/photo-actions/batches/[id]/apply/route';

// plans/active/photo-albums/plan.md, Phase 3: the route halves of AC-6, AC-9, AC-10 and AC-11,
// the photo list with no filter / an album / no project, and the 401 and 503 boundaries.
// Every scenario owns its rows, and afterAll removes every photo this file made.
type Context = { params: Promise<{ id: string }> };
type Handler = (request: Request, context: Context) => Promise<Response>;

describe('album, bulk tag, optional project, and photo link routes (photo-albums AC-6, AC-9, AC-10, AC-11)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const madePhotos: string[] = [];
  const madeAlbums: string[] = [];

  const gate = async (open: boolean) =>
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: open, mcp_enabled: true, repair_enabled: true })).error).toBeNull();

  beforeAll(async () => {
    f = await createFixtures();
    // Premise P2: one photo per content hash. Production builds this index at cutover.
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  });
  beforeEach(async () => { await gate(true); });
  afterAll(async () => {
    if (!f) return;
    // Later files (the 100,000-entry import test) need a small library, and the
    // far-future capture dates below must not sit at the head of anyone else's list.
    await f.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
    await f.sql.query('delete from public.albums where id=any($1::uuid[])', [madeAlbums]);
    await f.close();
  });

  /** Calls a real route handler with a real signed-in cookie jar. `body === undefined` sends none. */
  async function call(handler: Handler | ((request: Request) => Promise<Response>), path: string, options: {
    method?: string; body?: unknown; actor?: FixtureActor | null; from?: string; id?: string } = {}) {
    const method = options.method ?? 'GET';
    const request = new Request(`${origin}${path}`, { method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: options.from ?? origin },
      ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }) });
    const cookies = options.actor === null ? [] : (options.actor ?? f.employeeA).cookies;
    return withRequest(request, cookies, () => (handler as Handler)(request, { params: Promise.resolve({ id: options.id ?? '' }) }));
  }
  async function json(response: Response, status = 200) {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  }

  async function job(name = 'Album routes fixture') {
    const id = randomUUID();
    expect((await f.admin.from('jobs').insert({ id, job_number: `album-routes-${id}`, name })).error).toBeNull();
    return id;
  }
  /** A photo row written directly, as the other route suites do. `jobId: null` is a photo with no project. */
  async function photo(options: { jobId?: string | null; tags?: string[]; capturedAt?: string; trashed?: boolean } = {}) {
    const id = randomUUID(); const now = Date.now();
    expect((await f.admin.from('photos').insert({ id, job_id: options.jobId === undefined ? await job() : options.jobId,
      uploader_id: f.employeeA.id, kind: 'image', captured_at: options.capturedAt ?? new Date(now).toISOString(), tags: options.tags ?? [],
      original_path: `originals/${f.employeeA.id}/${id}/fixture.jpg`, original_name: 'fixture.jpg', thumb_path: `derived/${f.employeeA.id}/${id}_thumb.webp`,
      ...(options.trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeA.id, purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}),
    })).error).toBeNull();
    madePhotos.push(id);
    return id;
  }
  async function album(name = 'Route album', actor = f.employeeA) {
    const created = await json(await call(createAlbum, '/api/photo-albums', { method: 'POST', body: { name }, actor }), 201);
    madeAlbums.push(created.album.id);
    return created.album.id as string;
  }
  const add = (albumId: string, photo_ids: unknown, actor?: FixtureActor | null) =>
    call(addPhotos, `/api/photo-albums/${albumId}/photos`, { method: 'POST', body: { photo_ids }, id: albumId, actor });
  const remove = (albumId: string, photo_ids: unknown, actor?: FixtureActor | null) =>
    call(removePhotos, `/api/photo-albums/${albumId}/photos`, { method: 'DELETE', body: { photo_ids }, id: albumId, actor });
  const tag = (body: unknown, actor?: FixtureActor | null) => call(bulkTag, '/api/photos/tags', { method: 'POST', body, actor });
  const list = async (query: string, actor?: FixtureActor) => json(await call(listPhotos, `/api/photos${query}`, { actor }));
  const ids = (body: { photos: Array<{ id: string }> }) => body.photos.map(row => row.id);
  const members = async (photoId: string) =>
    (await f.sql.query('select album_id from public.album_photos where photo_id=$1 order by album_id', [photoId])).rows.map(row => row.album_id as string);
  const tagsOf = async (photoId: string) => (await f.sql.query('select tags from public.photos where id=$1', [photoId])).rows[0].tags as string[];

  describe('AC-6: the upload attempt names a project, an album, or both', () => {
    function input(jobId: string | null | undefined, albumIds: unknown, bytes = randomBytes(8)) {
      const id = randomUUID();
      return { bytes, body: { attempt_id: id, photo_id: randomUUID(), ...(jobId === undefined ? {} : { job_id: jobId }),
        ...(albumIds === undefined ? {} : { album_ids: albumIds }), source_signature: `album-route:${id}`,
        content_sha256: createHash('sha256').update(bytes).digest('hex'), original_name: 'fixture.jpg', original_bytes: bytes.length, mime_type: 'image/jpeg' } };
    }
    const post = (handler: (request: Request) => Promise<Response>, body: unknown) => call(handler, '/api/photos', { method: 'POST', body });

    it('refuses an attempt naming neither, with a null, a missing, or an empty value, and stores nothing', async () => {
      for (const value of [input(null, []), input(null, undefined), input(undefined, undefined), input(undefined, [])]) {
        const refused = await json(await post(attempt, value.body), 400);
        expect(refused.error.code).toBe('invalid_input');
        expect((await f.admin.from('photo_upload_attempts').select('id').eq('id', value.body.attempt_id)).data).toEqual([]);
      }
    });

    it('refuses album ids that are malformed, unknown, or deleted', async () => {
      const gone = await album('Deleted before upload');
      await json(await call(deleteAlbum, `/api/photo-albums/${gone}`, { method: 'DELETE', id: gone }));
      for (const albumIds of ['not-a-list', ['not-a-uuid'], [randomUUID()], [gone], [7]]) {
        expect((await json(await post(attempt, input(null, albumIds).body), 400)).error.code).toBe('invalid_input');
      }
    });

    it('album only: accepted with a null project, and the finished photo has no project and sits in that album', async () => {
      const target = await album('Christmas Party');
      const value = input(null, [target, target]); // a repeated id is one album
      const created = await json(await post(attempt, value.body));
      expect(created).toMatchObject({ owner_kind: 'ordinary', owner_id: value.body.attempt_id, photo_id: value.body.photo_id, job_id: null, result: null });
      expect((await f.admin.from('photo_upload_attempts').select('job_id,album_ids').eq('id', value.body.attempt_id).single()).data)
        .toEqual({ job_id: null, album_ids: [target] });
      // The same request again is a replay; the same attempt with other albums is a conflict.
      expect((await json(await post(attempt, value.body))).owner_id).toBe(value.body.attempt_id);
      await json(await post(attempt, { ...value.body, album_ids: [target, await album('Another')] }), 409);

      const owner = { owner_kind: created.owner_kind, owner_id: created.owner_id };
      const lease = await json(await post(acquire, owner));
      const claimed = await json(await post(claim, { ...owner, lease_generation: lease.lease_generation }));
      expect(claimed.status).toBe('claimed');
      expect((await f.employeeA.client.storage.from('photos').upload(created.original_path, value.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
      const payload = { ...owner, lease_generation: lease.lease_generation, claim_generation: claimed.claim_generation,
        id: created.photo_id, job_id: null, kind: 'image', tags: [], captured_at: null, captured_at_source: 'upload',
        original_path: created.original_path, original_bytes: value.bytes.length, mime_type: 'image/jpeg', original_name: 'fixture.jpg',
        thumb_path: null, preview_path: null, duration_secs: null, sidecar_path: null, sidecar_name: null,
        content_sha256: value.body.content_sha256, warnings: [] };
      // Finalize checks the project against the attempt: naming one here is a mismatch.
      await json(await post(finalize, { ...payload, job_id: await job() }), 409);
      const outcome = await json(await post(finalize, payload));
      madePhotos.push(created.photo_id);
      expect(outcome).toMatchObject({ status: 'created', photo_id: created.photo_id, job_id: null });
      expect((await f.admin.from('photos').select('job_id,deleted_at').eq('id', created.photo_id).single()).data).toEqual({ job_id: null, deleted_at: null });
      expect(await members(created.photo_id)).toEqual([target]);
      // The list and the single-photo read both show it, with no project.
      expect(ids(await list(`?album=${target}`))).toEqual([created.photo_id]);
      expect((await json(await call(onePhoto, `/api/photos/${created.photo_id}`, { id: created.photo_id }))).photo)
        .toMatchObject({ id: created.photo_id, job_id: null, job: null, albums: [{ id: target, name: 'Christmas Party' }] });
      await f.admin.storage.from('photos').remove([created.original_path]);
    });

    it('project only is unchanged, and a project plus albums stores both', async () => {
      const project = await job(); const target = await album('With a project');
      const plain = await json(await post(attempt, input(project, undefined).body));
      expect(plain.job_id).toBe(project);
      const both = input(project, [target]);
      expect((await json(await post(attempt, both.body))).job_id).toBe(project);
      expect((await f.admin.from('photo_upload_attempts').select('job_id,album_ids').eq('id', both.body.attempt_id).single()).data)
        .toEqual({ job_id: project, album_ids: [target] });
    });
  });

  describe('albums: create, list, rename, delete, restore (Decisions 2, 7, 8)', () => {
    it('any employee creates, renames, deletes and restores any album; deleted albums leave the list and appear under ?deleted=1', async () => {
      const unique = randomUUID().slice(0, 8);
      const created = await json(await call(createAlbum, '/api/photo-albums', { method: 'POST', body: { name: `  Marketing   ${unique} ` } }), 201);
      madeAlbums.push(created.album.id);
      expect(created).toMatchObject({ status: 'created', album: { name: `Marketing ${unique}`, created_by: f.employeeA.id, deleted_at: null } });
      const id = created.album.id as string;
      // Names need not be unique.
      madeAlbums.push((await json(await call(createAlbum, '/api/photo-albums', { method: 'POST', body: { name: `Marketing ${unique}` } }), 201)).album.id);

      const inAlbum = await photo(); const trashed = await photo({ trashed: true });
      expect(await json(await add(id, [inAlbum, trashed]))).toEqual({ added: 1, already: 0, missing: 1 });
      const cards = await json(await call(listAlbums, `/api/photo-albums?q=${unique}`, { actor: f.employeeB }));
      expect(cards.albums).toHaveLength(2);
      expect(cards.albums.find((card: { id: string }) => card.id === id)).toEqual({ id, name: `Marketing ${unique}`, photo_count: 1,
        thumb_paths: [`derived/${f.employeeA.id}/${inAlbum}_thumb.webp`], created_at: created.album.created_at });

      // Employee B renames and deletes employee A's album.
      const renamed = await json(await call(patchAlbum, `/api/photo-albums/${id}`, { method: 'PATCH', body: { name: `Renamed ${unique}` }, id, actor: f.employeeB }));
      expect(renamed.album).toMatchObject({ id, name: `Renamed ${unique}`, created_by: f.employeeA.id });
      const deleted = await json(await call(deleteAlbum, `/api/photo-albums/${id}`, { method: 'DELETE', id, actor: f.employeeB }));
      expect(deleted.album).toMatchObject({ id, deleted_by: f.employeeB.id });
      expect(deleted.album.deleted_at).not.toBeNull();
      // A repeat does not restart the 30 days.
      expect((await json(await call(deleteAlbum, `/api/photo-albums/${id}`, { method: 'DELETE', id }))).album.deleted_at).toBe(deleted.album.deleted_at);
      // No photo was deleted, and the album is gone from every employee read.
      expect((await f.admin.from('photos').select('deleted_at').eq('id', inAlbum).single()).data?.deleted_at).toBeNull();
      expect((await json(await call(listAlbums, `/api/photo-albums?q=${unique}`))).albums.map((card: { id: string }) => card.id)).not.toContain(id);
      expect(ids(await list(`?album=${id}`))).toEqual([]);
      expect((await json(await call(onePhoto, `/api/photos/${inAlbum}`, { id: inAlbum }))).photo.albums).toEqual([]);
      // Writes to a deleted album are refused until it is restored.
      await json(await call(patchAlbum, `/api/photo-albums/${id}`, { method: 'PATCH', body: { name: 'While deleted' }, id }), 404);
      await json(await add(id, [inAlbum]), 404);

      const trash = await json(await call(listAlbums, '/api/photo-albums?deleted=1', { actor: f.administrator }));
      const row = trash.albums.find((entry: { id: string }) => entry.id === id);
      expect(row).toEqual({ id, name: `Renamed ${unique}`, deleted_at: deleted.album.deleted_at, deleted_by: f.employeeB.id,
        restore_before: new Date(Date.parse(deleted.album.deleted_at) + 30 * 86_400_000).toISOString() });

      const restored = await json(await call(patchAlbum, `/api/photo-albums/${id}`, { method: 'PATCH', body: { action: 'restore' }, id, actor: f.employeeA }));
      expect(restored.album).toMatchObject({ id, deleted_at: null, deleted_by: null });
      expect(ids(await list(`?album=${id}`))).toEqual([inAlbum]); // it came back whole
      expect((await json(await call(listAlbums, '/api/photo-albums?deleted=1'))).albums.map((entry: { id: string }) => entry.id)).not.toContain(id);
    });

    it('after 30 days a deleted album is no longer listed or restorable', async () => {
      const id = await album('Too late');
      await json(await call(deleteAlbum, `/api/photo-albums/${id}`, { method: 'DELETE', id }));
      await f.sql.query("update public.albums set deleted_at=now()-interval '31 days' where id=$1", [id]);
      expect((await json(await call(listAlbums, '/api/photo-albums?deleted=1'))).albums.map((entry: { id: string }) => entry.id)).not.toContain(id);
      expect((await json(await call(patchAlbum, `/api/photo-albums/${id}`, { method: 'PATCH', body: { action: 'restore' }, id }), 409)).error.code).toBe('conflict');
    });

    it('refuses bad names, bad ids, unknown albums, extra keys, and other origins', async () => {
      const id = await album('Strict');
      for (const body of [{}, { name: 7 }, { name: '   ' }, { name: 'x'.repeat(121) }]) {
        await json(await call(createAlbum, '/api/photo-albums', { method: 'POST', body }), 400);
      }
      for (const body of [{}, { name: 7 }, { name: ' ' }, { action: 'delete' }, { action: 'restore', name: 'Both' }, { name: 'Ok', created_by: f.employeeB.id }]) {
        await json(await call(patchAlbum, `/api/photo-albums/${id}`, { method: 'PATCH', body, id }), 400);
      }
      await json(await call(patchAlbum, '/api/photo-albums/not-a-uuid', { method: 'PATCH', body: { name: 'x' }, id: 'not-a-uuid' }), 400);
      const unknown = randomUUID();
      await json(await call(patchAlbum, `/api/photo-albums/${unknown}`, { method: 'PATCH', body: { name: 'x' }, id: unknown }), 404);
      await json(await call(patchAlbum, `/api/photo-albums/${unknown}`, { method: 'PATCH', body: { action: 'restore' }, id: unknown }), 404);
      await json(await call(deleteAlbum, `/api/photo-albums/${unknown}`, { method: 'DELETE', id: unknown }), 404);
      await json(await call(listAlbums, '/api/photo-albums?deleted=yes'), 400);
      await json(await call(createAlbum, '/api/photo-albums', { method: 'POST', body: { name: 'Cross' }, from: 'https://evil.example' }), 403);
      expect((await f.admin.from('albums').select('name').eq('id', id).single()).data?.name).toBe('Strict');
    });
  });

  describe('AC-9: adding and removing photos is repeat-safe, up to 500 at a time', () => {
    it('repeats an add and a remove without change, and counts trashed and unknown ids as missing', async () => {
      const target = await album('Repeat safe'); const project = await job();
      const photos = [await photo({ jobId: project }), await photo({ jobId: project }), await photo({ jobId: null })];
      expect(await json(await add(target, photos))).toEqual({ added: 3, already: 0, missing: 0 });
      expect(await json(await add(target, photos, f.employeeB))).toEqual({ added: 0, already: 3, missing: 0 });
      expect(await json(await add(target, [photos[0], await photo({ trashed: true }), randomUUID()]))).toEqual({ added: 0, already: 1, missing: 2 });
      // A photo can be in several albums.
      const second = await album('Second home');
      expect(await json(await add(second, [photos[0]]))).toEqual({ added: 1, already: 0, missing: 0 });
      expect((await members(photos[0])).sort()).toEqual([target, second].sort());

      expect(await json(await remove(target, photos.slice(0, 2)))).toEqual({ removed: 2 });
      expect(await json(await remove(target, photos.slice(0, 2), f.employeeB))).toEqual({ removed: 0 });
      expect(ids(await list(`?album=${target}`))).toEqual([photos[2]]);
      // Removing from an album never touches the photo or its other albums.
      expect(await members(photos[0])).toEqual([second]);
      expect((await f.admin.from('photos').select('deleted_at').eq('id', photos[0]).single()).data?.deleted_at).toBeNull();
    });

    it('accepts exactly 500 ids in one request and refuses 501, none, and malformed lists', async () => {
      const target = await album('Limits'); const real = [await photo(), await photo()];
      // 500 ids are about 20 KB of JSON, past the default 16 KB body limit: the route must still read them.
      const fiveHundred = [...real, ...Array.from({ length: 498 }, () => randomUUID())];
      expect(await json(await add(target, fiveHundred))).toEqual({ added: 2, already: 0, missing: 498 });
      expect(await json(await add(target, fiveHundred))).toEqual({ added: 0, already: 2, missing: 498 });
      expect(await json(await remove(target, fiveHundred))).toEqual({ removed: 2 });
      expect(await json(await remove(target, fiveHundred))).toEqual({ removed: 0 });

      const tooMany = [...real, ...Array.from({ length: 499 }, () => randomUUID())];
      for (const change of [add, remove]) {
        for (const bad of [tooMany, [], null, 'all', ['not-a-uuid'], [7]]) {
          expect((await json(await change(target, bad), 400)).error.code).toBe('invalid_input');
        }
      }
      expect((await json(await tag({ photo_ids: tooMany, add: ['limit'] }), 400)).error.code).toBe('invalid_input');
      expect(await members(real[0])).toEqual([]);
      expect(await tagsOf(real[0])).toEqual([]);
      // Extra keys are refused rather than ignored, and an unknown album is 404.
      await json(await call(addPhotos, `/api/photo-albums/${target}/photos`, { method: 'POST', body: { photo_ids: real, album: target }, id: target }), 400);
      const unknown = randomUUID();
      await json(await add(unknown, real), 404);
      await json(await remove(unknown, real), 404);
      await json(await add('not-a-uuid', real), 400);
    });
  });

  describe('AC-10: bulk tagging', () => {
    it('adds and removes across photos, skips and counts a photo at the 20-tag limit, and repeats without change', async () => {
      const full = Array.from({ length: 20 }, (_, index) => `limit-${index}`); const added = `over-${randomUUID()}`;
      const atLimit = await photo({ tags: full }); const roomy = await photo({ tags: ['limit-0', 'before'] });
      const noProject = await photo({ jobId: null }); const trashed = await photo({ trashed: true });
      const body = { photo_ids: [atLimit, roomy, noProject, trashed, randomUUID()], add: [added], remove: ['BEFORE'] };
      expect(await json(await tag(body))).toEqual({ updated: 2, skipped: 1, missing: 2 });
      expect(await tagsOf(atLimit)).toEqual(full); // left entirely unchanged
      expect(await tagsOf(roomy)).toEqual(['limit-0', added]); // removal ignores case
      expect(await tagsOf(noProject)).toEqual([added]);
      expect(await tagsOf(trashed)).toEqual([]);
      expect(await json(await tag(body, f.employeeB))).toEqual({ updated: 2, skipped: 1, missing: 2 });
      expect(await tagsOf(roomy)).toEqual(['limit-0', added]);
      // The list filter finds what the bulk call tagged.
      expect(ids(await list(`?tags=${added}`)).sort()).toEqual([roomy, noProject].sort());
    });

    it('stores the existing spelling: adding Kitchen when kitchen exists stores kitchen', async () => {
      const unique = randomUUID().slice(0, 8); const stored = `kitchen-${unique}`; const typed = `Kitchen-${unique}`;
      await photo({ tags: [stored] });
      const target = await photo();
      expect(await json(await tag({ photo_ids: [target], add: [typed] }))).toEqual({ updated: 1, skipped: 0, missing: 0 });
      expect(await tagsOf(target)).toEqual([stored]);
      // A brand-new tag is stored as typed, trimmed.
      expect(await json(await tag({ photo_ids: [target], add: [`  Fresh ${unique} `] }))).toEqual({ updated: 1, skipped: 0, missing: 0 });
      expect(await tagsOf(target)).toEqual([stored, `Fresh ${unique}`]);
    });

    it('refuses empty, over-long, mistyped, and contradictory requests, and writes nothing', async () => {
      const target = await photo({ tags: ['kept'] });
      for (const bad of [{}, { add: [], remove: [] }, { add: ['   '] }, { add: ['x'.repeat(65)] }, { add: 'kitchen' }, { add: [7] }, { remove: [null] },
        { add: Array.from({ length: 21 }, (_, index) => `t${index}`) }, { add: ['Same'], remove: ['same'] }, { add: ['ok'], tags: ['ok'] }]) {
        expect((await json(await tag({ photo_ids: [target], ...bad }), 400)).error.code, JSON.stringify(bad)).toBe('invalid_input');
      }
      expect((await json(await tag({ add: ['ok'] }), 400)).error.code).toBe('invalid_input');
      expect(await tagsOf(target)).toEqual(['kept']);
    });
  });

  describe('GET /api/photos: no filter, an album, no project; filters combine', () => {
    it('lists every photo newest first with keyset paging when no filter is given', async () => {
      // Far-future capture times put these three at the head of the whole library, whatever
      // other files left behind: every other fixture is dated around today. afterAll removes them.
      const project = await job();
      const newest = await photo({ jobId: null, capturedAt: '2099-03-03T00:00:00.000Z' });
      const middle = await photo({ jobId: project, capturedAt: '2099-02-02T00:00:00.000Z' });
      const oldest = await photo({ jobId: null, capturedAt: '2099-01-01T00:00:00.000Z' });
      await photo({ jobId: null, capturedAt: '2099-04-04T00:00:00.000Z', trashed: true }); // newer than all three, and never listed

      const first = await list('?limit=2');
      expect(ids(first)).toEqual([newest, middle]);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.photos[0]).toMatchObject({ job_id: null, job: null });
      expect(first.photos[1]).toMatchObject({ job_id: project, job: { id: project } });
      const second = await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
      expect(second.photos[0].id).toBe(oldest);
      // The default page size applies, and an empty query string is a valid request.
      const plain = await list('');
      expect(ids(plain).slice(0, 3)).toEqual([newest, middle, oldest]);
    });

    it('filters by album and by no project, and combines them with tags, uploader, project and search', async () => {
      const project = await job('Combine project'); const unique = `combine-${randomUUID()}`;
      const target = await album('Combine'); const other = await album('Other');
      const loose = await photo({ jobId: null, tags: [unique], capturedAt: '2031-01-04T00:00:00.000Z' });
      const looseUntagged = await photo({ jobId: null, capturedAt: '2031-01-03T00:00:00.000Z' });
      const owned = await photo({ jobId: project, tags: [unique], capturedAt: '2031-01-02T00:00:00.000Z' });
      const elsewhere = await photo({ jobId: project, tags: [unique], capturedAt: '2031-01-01T00:00:00.000Z' });
      const trashed = await photo({ jobId: null, tags: [unique], trashed: true });
      expect(await json(await add(target, [loose, looseUntagged, owned]))).toEqual({ added: 3, already: 0, missing: 0 });
      expect(await json(await add(other, [elsewhere, loose]))).toEqual({ added: 2, already: 0, missing: 0 });
      // Membership of a trashed photo is kept in the table but never listed.
      await f.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [target, trashed, f.employeeA.id]);

      const inAlbum = await list(`?album=${target}`);
      expect(ids(inAlbum)).toEqual([loose, looseUntagged, owned]);
      expect(inAlbum.nextCursor).toBeNull();
      expect(inAlbum.photos.every((row: object) => !('albums' in row) && !('album_photos' in row))).toBe(true);
      expect(inAlbum.photos[2]).toMatchObject({ job_id: project, job: { id: project, name: 'Combine project' } });
      // Paging inside an album.
      const page = await list(`?album=${target}&limit=2`);
      expect(ids(page)).toEqual([loose, looseUntagged]);
      expect(ids(await list(`?album=${target}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`))).toEqual([owned]);

      expect(ids(await list(`?job=none&tags=${unique}`))).toEqual([loose]);
      expect((await list('?job=none&limit=200')).photos.every((row: { job_id: string | null }) => row.job_id === null)).toBe(true);
      expect(ids(await list(`?album=${target}&job=none`))).toEqual([loose, looseUntagged]);
      expect(ids(await list(`?album=${target}&job=none&tags=${unique}`))).toEqual([loose]);
      expect(ids(await list(`?album=${target}&job=${project}`))).toEqual([owned]);
      expect(ids(await list(`?album=${target}&tags=${unique}`))).toEqual([loose, owned]);
      expect(ids(await list(`?album=${target}&uploader=${f.employeeA.id}`, f.employeeB))).toEqual([loose, looseUntagged, owned]);
      expect(ids(await list(`?album=${target}&uploader=${f.employeeB.id}`))).toEqual([]);
      expect(ids(await list(`?album=${target}&q=${unique}`))).toEqual([loose, owned]);
      expect(ids(await list(`?album=${other}&job=none&q=${unique}`))).toEqual([loose]);
      expect(ids(await list(`?album=${randomUUID()}`))).toEqual([]);

      for (const bad of ['?album=not-a-uuid', '?job=nothing', '?job=None']) {
        expect((await call(listPhotos, `/api/photos${bad}`)).status, bad).toBe(400);
      }
    });
  });

  describe('AC-11: a photo opens by id, and both link shapes resolve on both addresses', () => {
    it('GET /api/photos/[id] returns any active photo, however old, with its project or null and its live albums', async () => {
      const project = await job('Old project');
      const ancient = await photo({ jobId: null, capturedAt: '1999-12-31T23:59:59.000Z' });
      const owned = await photo({ jobId: project, capturedAt: '1999-12-30T00:00:00.000Z' });
      const zebra = await album('Zebra'); const apple = await album('Apple'); const gone = await album('Gone');
      for (const target of [zebra, apple, gone]) await json(await add(target, [ancient]));
      await json(await call(deleteAlbum, `/api/photo-albums/${gone}`, { method: 'DELETE', id: gone }));
      // Far older than the first page of the list, so only a read by id can open it.
      expect(ids(await list('?limit=1'))).not.toContain(ancient);

      for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
        const body = await json(await call(onePhoto, `/api/photos/${ancient}`, { id: ancient, actor }));
        expect(body.photo).toMatchObject({ id: ancient, job_id: null, job: null, uploader_id: f.employeeA.id,
          albums: [{ id: apple, name: 'Apple' }, { id: zebra, name: 'Zebra' }] });
        expect(body.photo).not.toHaveProperty('sheet_number');
      }
      const withProject = await json(await call(onePhoto, `/api/photos/${owned}`, { id: owned }));
      expect(withProject.photo).toMatchObject({ id: owned, job_id: project, job: { id: project, name: 'Old project' }, albums: [] });
      expect(withProject.photo.job.job_number).toBe(`album-routes-${project}`);

      const trashed = await photo({ trashed: true }); const unknown = randomUUID();
      await json(await call(onePhoto, `/api/photos/${trashed}`, { id: trashed }), 404);
      await json(await call(onePhoto, `/api/photos/${unknown}`, { id: unknown }), 404);
      await json(await call(onePhoto, '/api/photos/not-a-uuid', { id: 'not-a-uuid' }), 400);
    });

    it('the server parser accepts /photos?photo=<id> and /photos/<jobId>?photo=<id> on the new and the old address, and nothing looser', async () => {
      const project = await job(); const owned = await photo({ jobId: project }); const loose = await photo({ jobId: null });
      const draft = (photo_url: string) => call(createBatch, '/api/photo-actions/batches', { method: 'POST', body: { action: 'trash', selector: { photos: [{ photo_url }] } } });
      const resolves = async (photo_url: string, expected: string) => {
        const created = await json(await draft(photo_url));
        const listed = await json(await call(materialize, `/api/photo-actions/batches/${created.batch.id}/materialize`, { method: 'POST', id: created.batch.id }));
        expect(listed.unresolved, photo_url).toEqual([]);
        expect(listed.items.map((item: { photo_id: string }) => item.photo_id), photo_url).toEqual([expected]);
      };
      for (const address of ['https://photos.design-workshops.app', 'https://photos.dws-receipts.com', origin, '']) {
        await resolves(`${address}/photos?photo=${loose}`, loose);          // the shape "Copy link" writes, for a photo with no project
        await resolves(`${address}/photos?photo=${owned}`, owned);
        await resolves(`${address}/photos/${project}?photo=${owned}`, owned); // a link already sent
      }
      for (const photo_url of [`https://evil.example/photos?photo=${loose}`, `http://photos.design-workshops.app/photos?photo=${loose}`,
        '/photos', '/photos?photo=not-a-uuid', `/photos/not-a-uuid?photo=${owned}`, `/photos/albums?photo=${loose}`,
        `/photos/albums/${project}?photo=${loose}`, `/photos/${project}/more?photo=${owned}`, `/s/${project}?photo=${loose}`, `/?photo=${loose}`]) {
        expect((await json(await draft(photo_url), 400)).error.code, photo_url).toBe('invalid_input');
      }
      expect((await f.admin.from('photos').select('id').in('id', [owned, loose]).is('deleted_at', null)).data).toHaveLength(2);
    });
  });

  describe('a move to "No project" (Decision 1)', () => {
    it('needs an explicit null destination, clears the project, and shows in the no-project list', async () => {
      const project = await job(); const target = await photo({ jobId: project, tags: [`cleared-${randomUUID()}`] });
      const selector = { photos: [{ photo_id: target }] };
      // Leaving the destination out is still a mistake, not "No project".
      await json(await call(createBatch, '/api/photo-actions/batches', { method: 'POST', body: { action: 'move', selector } }), 400);
      const created = await json(await call(createBatch, '/api/photo-actions/batches', { method: 'POST', body: { action: 'move', selector, destination_job_id: null } }));
      expect(created.batch).toMatchObject({ action: 'move', destination_job_id: null, destination_job: null });
      const batch = created.batch.id as string;
      const listed = await json(await call(materialize, `/api/photo-actions/batches/${batch}/materialize`, { method: 'POST', id: batch }));
      expect(listed.items[0]).toMatchObject({ photo_id: target, expected_job_id: project });
      await json(await call(approve, `/api/photo-actions/batches/${batch}/approve`, { method: 'POST', id: batch }));
      const applied = await json(await call(apply, `/api/photo-actions/batches/${batch}/apply`, { method: 'POST', body: { photo_ids: [target] }, id: batch }));
      expect(applied.outcomes[0].status).toBe('applied');
      expect((await json(await call(onePhoto, `/api/photos/${target}`, { id: target }))).photo).toMatchObject({ job_id: null, job: null });
      expect(ids(await list(`?job=none&tags=${(await tagsOf(target))[0]}`))).toEqual([target]);
      // A trash action still never takes a destination.
      await json(await call(createBatch, '/api/photo-actions/batches', { method: 'POST', body: { action: 'trash', selector, destination_job_id: project } }), 400);
    });
  });

  describe('signed out is 401, and a closed writes gate is 503 for every write while reads keep working', () => {
    it('refuses every new route without a session and changes nothing', async () => {
      const target = await album('Boundaries'); const subject = await photo({ jobId: null, tags: ['kept'] });
      const writes: Array<[Handler | ((request: Request) => Promise<Response>), string, string, unknown, string?]> = [
        [createAlbum, '/api/photo-albums', 'POST', { name: 'Anonymous' }],
        [patchAlbum, `/api/photo-albums/${target}`, 'PATCH', { name: 'Anonymous' }, target],
        [patchAlbum, `/api/photo-albums/${target}`, 'PATCH', { action: 'restore' }, target],
        [deleteAlbum, `/api/photo-albums/${target}`, 'DELETE', {}, target],
        [addPhotos, `/api/photo-albums/${target}/photos`, 'POST', { photo_ids: [subject] }, target],
        [removePhotos, `/api/photo-albums/${target}/photos`, 'DELETE', { photo_ids: [subject] }, target],
        [bulkTag, '/api/photos/tags', 'POST', { photo_ids: [subject], add: ['anonymous'] }],
      ];
      const reads: Array<[Handler | ((request: Request) => Promise<Response>), string, string?]> = [
        [listAlbums, '/api/photo-albums'], [listAlbums, '/api/photo-albums?deleted=1'],
        [listPhotos, '/api/photos'], [listPhotos, `/api/photos?album=${target}`], [listPhotos, '/api/photos?job=none'],
        [onePhoto, `/api/photos/${subject}`, subject],
      ];
      const untouched = async () => {
        expect((await f.admin.from('albums').select('name,deleted_at').eq('id', target).single()).data).toEqual({ name: 'Boundaries', deleted_at: null });
        expect(await members(subject)).toEqual([]);
        expect(await tagsOf(subject)).toEqual(['kept']);
      };

      for (const [handler, path, method, body, id] of writes) {
        expect((await call(handler, path, { method, body, id, actor: null })).status, `${method} ${path}`).toBe(401);
      }
      for (const [handler, path, id] of reads) {
        expect((await call(handler, path, { id, actor: null })).status, `GET ${path}`).toBe(401);
      }
      await untouched();

      await gate(false);
      for (const [handler, path, method, body, id] of writes) {
        const response = await call(handler, path, { method, body, id });
        expect(response.status, `${method} ${path}`).toBe(503);
        expect((await response.json()).error.code).toBe('temporarily_unavailable');
      }
      await untouched();
      // Browsing does not depend on the writes gate. The deleted-album list does: it reads with the
      // service role, like the photo trash, so it closes with the gate.
      for (const [handler, path, id] of reads) {
        expect((await call(handler, path, { id })).status, `GET ${path}`).toBe(path.includes('deleted=1') ? 503 : 200);
      }
      await gate(true);
    });
  });
});
