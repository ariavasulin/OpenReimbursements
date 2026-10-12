import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
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

import { GET as twinRoute } from '@/app/api/photos/twin/route';

// AC-21 through the real route: the same shot already in a project in another format.
describe('GET /api/photos/twin', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const shot = '2031-04-05T06:07:08.000Z';
  const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
  const jobs = [randomUUID(), randomUUID()];
  let jpg: string;
  const ask = async (query: Record<string, string>, actor = f.employeeA) => {
    const request = new Request(`${origin}/api/photos/twin?${new URLSearchParams(query)}`, { headers: { origin } });
    const response = await withRequest(request, actor.cookies, () => twinRoute(request));
    return { status: response.status, body: await response.json() };
  };
  async function photo(job: string, name: string, capturedAt: string, extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    const inserted = await f.admin.from('photos').insert({ id, job_id: job, uploader_id: f.employeeB.id, kind: 'image',
      captured_at: capturedAt, original_path: `originals/${f.employeeB.id}/${id}/${name}`, original_name: name,
      content_sha256: sha(id), ...extra });
    expect(inserted.error).toBeNull();
    return id;
  }

  beforeAll(async () => {
    f = await createFixtures();
    for (const id of jobs) expect((await f.admin.from('jobs').insert({ id, job_number: `twin-${id}`, name: 'Format twins' })).error).toBeNull();
    jpg = await photo(jobs[0], 'IMG_1234.JPG', shot);
  });
  afterAll(async () => { await f?.close(); });

  it('matches IMG_1234.CR2 against IMG_1234.JPG in the same project, any case, within a second', async () => {
    const hit = await ask({ job: jobs[0], base: 'IMG_1234', captured_at: shot, sha: sha('the raw file') });
    expect(hit).toEqual({ status: 200, body: { photo: { id: jpg, job_id: jobs[0], original_name: 'IMG_1234.JPG',
      display_name: expect.anything(), captured_at: expect.any(String) } } });
    expect(Date.parse(hit.body.photo.captured_at)).toBe(Date.parse(shot));
    // Any case, and up to a second either way; the hash is optional.
    expect((await ask({ job: jobs[0], base: 'img_1234', captured_at: '2031-04-05T06:07:09.000Z' })).body.photo?.id).toBe(jpg);
    expect((await ask({ job: jobs[0], base: 'IMG_1234', captured_at: '2031-04-05T06:07:07.000Z' })).body.photo?.id).toBe(jpg);
  });

  it('answers null across projects, two seconds apart, for a longer name, for the same bytes, and once trashed', async () => {
    const none = { status: 200, body: { photo: null } };
    expect(await ask({ job: jobs[1], base: 'IMG_1234', captured_at: shot })).toEqual(none);
    expect(await ask({ job: jobs[0], base: 'IMG_1234', captured_at: '2031-04-05T06:07:10.000Z' })).toEqual(none);
    expect(await ask({ job: jobs[0], base: 'IMG_123', captured_at: shot })).toEqual(none);
    expect(await ask({ job: jobs[0], base: 'IMG_12_4', captured_at: shot })).toEqual(none);
    const stored = (await f.sql.query('select content_sha256 from public.photos where id=$1', [jpg])).rows[0].content_sha256;
    expect(await ask({ job: jobs[0], base: 'IMG_1234', captured_at: shot, sha: stored })).toEqual(none);
    // "IMG_1234.edit.jpg" is not another format of IMG_1234, and a video is never one.
    const edit = await photo(jobs[1], 'IMG_9.edit.jpg', shot);
    expect(await ask({ job: jobs[1], base: 'IMG_9', captured_at: shot })).toEqual(none);
    expect((await ask({ job: jobs[1], base: 'IMG_9.edit', captured_at: shot })).body.photo?.id).toBe(edit);
    await photo(jobs[1], 'IMG_5.MOV', shot, { kind: 'video' });
    expect(await ask({ job: jobs[1], base: 'IMG_5', captured_at: shot })).toEqual(none);
    const trashed = await photo(jobs[1], 'IMG_7.JPG', shot);
    expect((await ask({ job: jobs[1], base: 'IMG_7', captured_at: shot })).body.photo?.id).toBe(trashed);
    await f.sql.query("update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval '30 days' where id=$1", [trashed, f.employeeB.id]);
    expect(await ask({ job: jobs[1], base: 'IMG_7', captured_at: shot })).toEqual(none);
  });

  it('refuses a bad request and a signed-out caller', async () => {
    expect((await ask({ job: 'nope', base: 'IMG_1234', captured_at: shot })).status).toBe(400);
    expect((await ask({ job: jobs[0], base: '', captured_at: shot })).status).toBe(400);
    expect((await ask({ job: jobs[0], base: 'IMG_1234', captured_at: 'yesterday' })).status).toBe(400);
    expect((await ask({ job: jobs[0], base: 'IMG_1234', captured_at: shot, sha: 'abc' })).status).toBe(400);
    const request = new Request(`${origin}/api/photos/twin?job=${jobs[0]}&base=IMG_1234&captured_at=${shot}`);
    expect((await withRequest(request, [], () => twinRoute(request))).status).toBe(401);
  });
});
