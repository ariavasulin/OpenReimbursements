import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';
import { FILE_TYPE_LABELS, fileTypeLabel } from '@/lib/photos/file-type';
import type { PhotoKind } from '@/lib/photos/types';

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

import { GET as listPhotos } from '@/app/api/photos/route';
import { GET as listIds } from '@/app/api/photos/ids/route';
import { POST as createBatch } from '@/app/api/photo-actions/batches/route';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-A (A1, server): AC-10 filters AND,
// AC-11 search words AND, AC-13 and AC-14 GET /api/photos/ids, and the action batch's 5,000 limit.
// Every scenario owns its project; afterAll removes every row this file made.
describe('photo filters, search words, and select-all ids (W2-A: AC-10, AC-11, AC-13, AC-14)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const madeJobs: string[] = [];
  const madeBatches: string[] = [];
  let uploaderBName: string | null = null;

  beforeAll(async () => {
    f = await createFixtures();
    uploaderBName = (await f.sql.query('select full_name from public.user_profiles where user_id=$1', [f.employeeB.id])).rows[0].full_name;
  });
  beforeEach(async () => {
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
  });
  afterAll(async () => {
    if (!f) return;
    await f.sql.query('update public.user_profiles set full_name=$2 where user_id=$1', [f.employeeB.id, uploaderBName]);
    await f.sql.query('delete from public.photo_action_batches where id=any($1::uuid[])', [madeBatches]);
    await f.sql.query('delete from public.photos where job_id=any($1::uuid[])', [madeJobs]);
    await f.sql.query('delete from public.jobs where id=any($1::uuid[])', [madeJobs]);
    await f.close();
  });

  async function call(handler: (request: Request) => Promise<Response>, path: string, options: { body?: unknown; actor?: FixtureActor | null } = {}) {
    const post = options.body !== undefined;
    const request = new Request(`${origin}${path}`, post
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(options.body) }
      : {});
    return withRequest(request, options.actor === null ? [] : (options.actor ?? f.employeeA).cookies, () => handler(request));
  }
  async function json(response: Response, status = 200) {
    const body = await response.json();
    expect(response.status, JSON.stringify(body).slice(0, 500)).toBe(status);
    return body;
  }
  const list = async (query: string) => (await json(await call(listPhotos, `/api/photos?limit=200&${query}`))).photos.map((row: { id: string }) => row.id) as string[];
  const ids = async (query: string) => json(await call(listIds, `/api/photos/ids?${query}`));

  async function job(jobNumber = `filters-${randomUUID()}`, name = 'Filters fixture') {
    const id = randomUUID();
    expect((await f.admin.from('jobs').insert({ id, job_number: jobNumber, name })).error).toBeNull();
    madeJobs.push(id);
    return id;
  }
  async function photo(jobId: string, options: { uploader?: FixtureActor; tags?: string[]; capturedAt?: string; kind?: PhotoKind;
    name?: string | null; mime?: string | null } = {}) {
    const id = randomUUID(); const uploader = (options.uploader ?? f.employeeA).id;
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: uploader, kind: options.kind ?? 'image',
      captured_at: options.capturedAt ?? '2030-06-15T12:00:00.000Z', tags: options.tags ?? [],
      original_path: `originals/${uploader}/${id}/fixture`, original_name: options.name === undefined ? 'fixture.jpg' : options.name,
      mime_type: options.mime === undefined ? 'image/jpeg' : options.mime, thumb_path: `derived/${uploader}/${id}_thumb.webp`,
    })).error).toBeNull();
    return id;
  }
  /** `count` photos in one project, one second apart from `start` (so automatic names never collide), 1,000 per statement:
   * the automatic-name trigger takes an advisory lock per row, and one transaction runs out of lock memory at 6,000. */
  async function seed(jobId: string, count: number, start: string, tags: (n: number) => string[] = () => []) {
    const made: Array<{ id: string; captured_at: Date }> = [];
    for (let first = 1; first <= count; first += 1000) made.push(...await seedChunk(jobId, first, Math.min(count, first + 999), start, tags));
    return made;
  }
  async function seedChunk(jobId: string, first: number, last: number, start: string, tags: (n: number) => string[]) {
    const tagLists = Array.from({ length: last - first + 1 }, (_, index) => tags(first + index));
    const { rows } = await f.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,captured_at,tags,original_path,original_name,mime_type,thumb_path)
      select g.id,$1::uuid,$2::uuid,'image',$3::timestamptz + make_interval(secs => g.n),
        array(select jsonb_array_elements_text($4::jsonb -> (g.n - $5::int))),
        'originals/' || $2 || '/' || g.id || '/seed.jpg','seed.jpg','image/jpeg','derived/' || $2 || '/' || g.id || '_thumb.webp'
      from (select gen_random_uuid() id, n from generate_series($5::int,$6::int) n) g
      returning id, captured_at`, [jobId, f.employeeA.id, start, JSON.stringify(tagLists), first, last]);
    return rows as Array<{ id: string; captured_at: Date }>;
  }

  describe('AC-10: type, from/to, tags, and uploader combine with AND', () => {
    it('returns only the intersection, where each filter alone matches more', async () => {
      const project = await job(); const t = `ac10-${randomUUID()}`;
      const raw = { name: 'IMG_1.DNG', mime: 'image/x-adobe-dng' };
      const all = { uploader: f.employeeB, tags: [`${t}-a`, `${t}-b`], capturedAt: '2030-06-15T12:00:00.000Z', ...raw };
      const target = await photo(project, all);
      const wrongType = await photo(project, { ...all, name: 'IMG_2.JPG', mime: 'image/jpeg' });
      const wrongDate = await photo(project, { ...all, capturedAt: '2030-07-15T12:00:00.000Z' });
      const oneTag = await photo(project, { ...all, tags: [`${t}-a`] });
      const otherUploader = await photo(project, { ...all, uploader: f.employeeA });

      const type = 'type=raw', range = 'from=2030-06-01T07:00:00.000Z&to=2030-07-01T06:59:59.999Z';
      const tags = `tags=${t}-a,${t}-b`, uploader = `uploader=${f.employeeB.id}`, scope = `job=${project}`;
      expect(new Set(await list(`${scope}&${type}`))).toEqual(new Set([target, wrongDate, oneTag, otherUploader]));
      expect(new Set(await list(`${scope}&${range}`))).toEqual(new Set([target, wrongType, oneTag, otherUploader]));
      expect(new Set(await list(`${scope}&${tags}`))).toEqual(new Set([target, wrongType, wrongDate, otherUploader]));
      expect(new Set(await list(`${scope}&${uploader}`))).toEqual(new Set([target, wrongType, wrongDate, oneTag]));
      expect(await list(`${scope}&${type}&${range}&${tags}&${uploader}`)).toEqual([target]);
      // The ids route shares the parser and the query.
      expect(await ids(`${scope}&${type}&${range}&${tags}&${uploader}`)).toEqual({ ids: [target], total: 1, truncated: false });

      // from and to are inclusive instants; an offset is read as written.
      expect(await list(`${scope}&${uploader}&${tags}&from=2030-06-15T12:00:00.000Z&to=2030-06-15T12:00:00.000Z&${type}`)).toEqual([target]);
      expect(await list(`${scope}&${uploader}&${type}&from=${encodeURIComponent('2030-06-15T05:00:00.001-07:00')}`)).toEqual([wrongDate]);
      for (const bad of ['type=RAW', 'type=gif', 'from=2030-06-01', 'to=June', 'from=2030-06-01T00:00:00']) {
        expect((await call(listPhotos, `/api/photos?${bad}`)).status, bad).toBe(400);
        expect((await call(listIds, `/api/photos/ids?${bad}`)).status, bad).toBe(400);
      }
    });

    it('type= picks exactly the photos fileTypeLabel names, by name first and MIME type second', async () => {
      const project = await job();
      const cases: Array<{ kind: PhotoKind; name: string | null; mime: string | null }> = [
        { kind: 'image', name: 'a.JPG', mime: 'image/jpeg' }, { kind: 'image', name: 'b.jpeg', mime: null },
        { kind: 'image', name: 'c.HEIC', mime: 'image/heic' }, { kind: 'image', name: 'd.heif', mime: 'application/octet-stream' },
        { kind: 'image', name: 'e.png', mime: 'image/png' }, { kind: 'file', name: 'f.CR3', mime: 'application/octet-stream' },
        { kind: 'file', name: 'g.nef', mime: null }, { kind: 'image', name: 'h.TIFF', mime: 'image/tiff' },
        { kind: 'image', name: 'photo', mime: 'image/jpeg' }, { kind: 'image', name: null, mime: 'image/x-sony-arw' },
        { kind: 'image', name: null, mime: 'IMAGE/PNG' }, { kind: 'image', name: '.jpg', mime: 'image/png' },
        { kind: 'image', name: 'x.jpg.png', mime: 'image/jpeg' }, { kind: 'image', name: 'scan.png', mime: 'image/jpeg' },
        { kind: 'video', name: 'clip.mov', mime: 'video/quicktime' }, { kind: 'video', name: 'odd.jpg', mime: 'image/jpeg' },
        { kind: 'file', name: 'clip.webm', mime: 'video/webm' }, { kind: 'file', name: 'notes.pdf', mime: 'application/pdf' },
        { kind: 'image', name: 'anim.gif', mime: 'image/gif' }, { kind: 'file', name: null, mime: null },
        { kind: 'image', name: 'IMG_1.webp', mime: 'image/png' },
      ];
      const made = await Promise.all(cases.map(async (row, index) => ({ ...row,
        id: await photo(project, { ...row, capturedAt: `2030-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z` }) })));
      for (const label of FILE_TYPE_LABELS) {
        const expected = made.filter(row => fileTypeLabel({ kind: row.kind, original_name: row.name, mime_type: row.mime }) === label).map(row => row.id);
        expect(new Set(await list(`job=${project}&type=${label.toLowerCase()}`)), label).toEqual(new Set(expected));
      }
      // Every photo lands under exactly one label.
      const counts = await Promise.all(FILE_TYPE_LABELS.map(async label => (await ids(`job=${project}&type=${label.toLowerCase()}`)).total));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(cases.length);
    });
  });

  describe('AC-11: every search word must match a field', () => {
    it('"<project number> professional" matches only that project\'s photos tagged professional', async () => {
      const number = String(Math.floor(1e8 + Math.random() * 9e8));
      const project = await job(number, 'Search target'); const other = await job();
      const target = await photo(project, { tags: ['professional'] });
      await photo(project, { tags: ['field dimension'] });
      await photo(other, { tags: ['professional'] });
      expect(await list(`q=${number}+professional`)).toEqual([target]);
      expect(await list(`q=${encodeURIComponent(`  PROFESSIONAL\t${number} `)}`)).toEqual([target]);
      expect(await ids(`q=${number}+professional`)).toEqual({ ids: [target], total: 1, truncated: false });
    });

    it('"yana sept" matches nothing unless a photo\'s name holds "sept": words match fields, not dates', async () => {
      await f.sql.query('update public.user_profiles set full_name=$2 where user_id=$1', [f.employeeB.id, 'Yana Ronin']);
      const project = await job();
      const september = [await photo(project, { uploader: f.employeeB, capturedAt: '2030-09-10T12:00:00.000Z' }),
        await photo(project, { uploader: f.employeeB, capturedAt: '2030-09-11T12:00:00.000Z', tags: ['kitchen'] })];
      await photo(project, { uploader: f.employeeA, name: 'sept-walk.jpg' });
      expect(await list(`job=${project}&q=yana+sept`)).toEqual([]);
      expect(new Set(await list(`job=${project}&q=yana`))).toEqual(new Set(september));
      // The photo's own name, original or shown, counts as a field.
      const named = await photo(project, { uploader: f.employeeB, name: 'Sept walkthrough.JPG', capturedAt: '2030-09-12T12:00:00.000Z' });
      expect(await list(`job=${project}&q=yana+sept`)).toEqual([named]);
      await f.sql.query("update public.photos set display_name='Kitchen sept review', name_source='manual' where id=$1", [september[0]]);
      expect(new Set(await list(`job=${project}&q=yana+sept`))).toEqual(new Set([named, september[0]]));
      // A literal underscore or percent sign is not a wildcard.
      expect(await list(`job=${project}&q=${encodeURIComponent('sept_walk')}`)).toEqual([]);
      expect(await list(`job=${project}&q=${encodeURIComponent('sept-walk.jpg')}`)).toHaveLength(1);
      expect((await call(listPhotos, `/api/photos?q=${Array.from({ length: 9 }, (_, i) => `w${i}`).join('+')}`)).status).toBe(400);
    });
  });

  describe('GET /api/photos/ids', () => {
    it('AC-13: returns every one of 1,200 matches, and honours the same filters', async () => {
      const project = await job(); const half = `half-${randomUUID()}`;
      const rows = await seed(project, 1200, '2031-01-01T00:00:00.000Z', n => n % 2 === 0 ? [half] : []);
      const body = await ids(`job=${project}`);
      expect(body.total).toBe(1200);
      expect(body.truncated).toBe(false);
      expect(body.ids).toHaveLength(1200);
      expect(new Set(body.ids)).toEqual(new Set(rows.map(row => row.id)));
      // Newest first, the grid's own order; sort=asc walks the other way.
      const newestFirst = [...rows].sort((a, b) => b.captured_at.getTime() - a.captured_at.getTime()).map(row => row.id);
      expect(body.ids).toEqual(newestFirst);
      expect((await ids(`job=${project}&sort=asc`)).ids).toEqual([...newestFirst].reverse());
      const tagged = await ids(`job=${project}&tags=${half}`);
      expect(tagged).toMatchObject({ total: 600, truncated: false });
      expect(tagged.ids).toHaveLength(600);
      // The first grid page and the ids agree on which photos lead.
      expect(await list(`job=${project}`)).toEqual(newestFirst.slice(0, 200));
      expect(await ids(`job=${project}&from=2099-01-01T00:00:00Z`)).toEqual({ ids: [], total: 0, truncated: false });
    });

    it('AC-14: stops at 5,000 of 6,000 matches and says so', async () => {
      const project = await job();
      const rows = await seed(project, 6000, '2032-01-01T00:00:00.000Z');
      const body = await ids(`job=${project}`);
      expect(body).toMatchObject({ total: 6000, truncated: true });
      expect(body.ids).toHaveLength(5000);
      expect(new Set(body.ids).size).toBe(5000);
      const newestFirst = [...rows].sort((a, b) => b.captured_at.getTime() - a.captured_at.getTime()).map(row => row.id);
      expect(body.ids).toEqual(newestFirst.slice(0, 5000));
    });

    it('needs a session', async () => {
      expect((await call(listIds, '/api/photos/ids', { actor: null })).status).toBe(401);
    });
  });

  describe('the action batch takes a whole selection (Decision 6)', () => {
    it('accepts 501 and 5,000 photos in one batch and refuses 5,001', async () => {
      const refs = (count: number) => Array.from({ length: count }, () => ({ photo_id: randomUUID() }));
      for (const count of [501, 5000]) {
        const created = await json(await call(createBatch, '/api/photo-actions/batches', { body: { action: 'trash', selector: { photos: refs(count) } } }));
        madeBatches.push(created.batch.id);
        expect(created.batch.selector.photos).toHaveLength(count);
      }
      const refused = await json(await call(createBatch, '/api/photo-actions/batches', { body: { action: 'trash', selector: { photos: refs(5001) } } }), 400);
      expect(refused.error.code).toBe('invalid_input');
    });
  });
});
