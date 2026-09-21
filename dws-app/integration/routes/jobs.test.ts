import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { withRequest } from './request-context';
import { fetchJobs } from '@/lib/photos/api';

vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return {
    cookies: async () => ({
      get: (name: string) => {
        const value = requestContext.getStore()!.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); },
    }),
    headers: async () => requestContext.getStore()!.headers,
  };
});

import { GET as listJobs, POST as createJob } from '@/app/api/photo-jobs/route';
import { PATCH as renameJob } from '@/app/api/photo-jobs/[id]/route';

describe('hand-made project routes (photo-folders AC-2, AC-3, AC-5, AC-6)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'https://photos.example.test';
  // Upsert, not update: routes/authority.test.ts ends by deleting this row, and an
  // update cannot bring it back, so this file failed whenever it ran after that one.
  const gate = async (open: boolean) =>
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: open })).error).toBeNull();
  const request = (path: string, method: string, body: unknown, from = origin) => new Request(`${origin}${path}`, {
    method, headers: { 'content-type': 'application/json', origin: from }, body: JSON.stringify(body) });
  const create = (body: unknown, cookies = f.employeeA.cookies, from = origin) => {
    const r = request('/api/photo-jobs', 'POST', body, from);
    return withRequest(r, cookies, () => createJob(r));
  };
  const rename = (id: string, body: unknown) => {
    const r = request(`/api/photo-jobs/${id}`, 'PATCH', body);
    return withRequest(r, f.employeeB.cookies, () => renameJob(r, { params: Promise.resolve({ id }) }));
  };

  beforeAll(async () => { f = await createFixtures(); await gate(true); });
  afterAll(async () => { await f?.close(); });

  it('pages more than 1000 projects through the real route and client with numeric sort ties and search', async () => {
    const prefix = `job-pages-${randomUUID()}%_`;
    const ids = Array.from({ length: 1203 }, () => randomUUID());
    // Distinct numeric numbers can share the old zero-padded sort key.
    const numeric = String(Date.now());
    const numbers = ids.map((id, i) => i === 0 ? numeric : i === 1 ? `0${numeric}` : `pages-${id}`);
    await f.sql.query(`insert into public.jobs(id,job_number,name)
      select id,number,$3 from unnest($1::uuid[],$2::text[]) t(id,number)`, [ids, numbers, prefix]);
    const unrelated = randomUUID();
    await f.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)',
      [unrelated, `pages-${unrelated}`, prefix.replace('%_', 'XX')]);
    const photoIds = [randomUUID(), randomUUID(), randomUUID()];
    await f.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_path,captured_at,created_at)
      select photo,job,$3::uuid,'image','originals/' || photo::text || '/page.jpg',now(),'2040-01-01T00:00:00.000001Z'::timestamptz
      from unnest($1::uuid[],$2::uuid[]) t(photo,job)`, [photoIds, ids.slice(0, 3), f.employeeA.id]);
    const originalFetch = globalThis.fetch;
    const sizes: number[] = [];
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (typeof input === 'string' && input.startsWith('/api/photo-jobs?')) {
        const request = new Request(`${origin}${input}`);
        const response = await withRequest(request, f.employeeA.cookies, () => listJobs(request));
        expect(response.status).toBe(200);
        sizes.push((await response.clone().json()).jobs.length);
        return response;
      }
      return originalFetch(input, init);
    });
    try {
      const expected = (await f.sql.query(`select id from public.jobs where id=any($1::uuid[])
        order by (id=any($2::uuid[])) desc,
          (case when job_number ~ '^[0-9]+$' then lpad(job_number,20,'0') else job_number end) desc,id`, [ids, ids.slice(0, 3)])).rows.map(row => row.id);
      expect((await fetchJobs(prefix)).map(row => row.id)).toEqual(expected);
      expect(sizes).toEqual([200, 200, 200, 200, 200, 200, 3]);
      // Force the tied numeric pair to straddle a page boundary.
      const tiedPath = `/api/photo-jobs?q=${numeric}&limit=1`;
      const first = await (await fetch(tiedPath)).json();
      const second = await (await fetch(`${tiedPath}&cursor=${first.nextCursor}`)).json();
      expect([...first.jobs, ...second.jobs].map(row => row.id)).toEqual(ids.slice(0, 2).sort());
      expect(second.nextCursor).toBeNull();
    } finally {
      mocked.mockRestore();
      await f.sql.query('delete from public.photos where id=any($1::uuid[])', [photoIds]);
      await f.sql.query('delete from public.jobs where id=any($1::uuid[])', [[...ids, unrelated]]);
    }
  });

  it('rejects malformed project page limits and cursors', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'limit=', 'cursor=', 'cursor=garbage']) {
      const request = new Request(`${origin}/api/photo-jobs?${query}`);
      const response = await withRequest(request, f.employeeA.cookies, () => listJobs(request));
      expect(response.status).toBe(400);
    }
  });

  it('creates with a generated code, then reports an existing number without creating', async () => {
    const blank = await create({ name: 'Office party' });
    expect(blank.status).toBe(201);
    expect((await blank.json()).job.job_number).toMatch(/^P-\d+$/);
    const number = randomUUID().slice(0, 8);
    const first = await create({ name: 'Smith kitchen', job_number: number, location: 'Berkeley' });
    expect(first.status).toBe(201);
    const again = await create({ name: 'Other', job_number: number });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'exists', job: (await first.json()).job });
  });

  it('renames any job and keeps its number', async () => {
    const job = (await (await create({ name: 'Before' })).json()).job;
    const renamed = await rename(job.id, { name: 'After' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).job).toEqual({ ...job, name: 'After' });
    expect((await rename(randomUUID(), { name: 'x' })).status).toBe(404);
    expect((await rename('not-a-uuid', { name: 'x' })).status).toBe(400);
  });

  it('rejects bad input, other origins, signed-out callers, and a closed gate', async () => {
    expect((await create({ name: 7 })).status).toBe(400);
    expect((await create({ name: '  ' })).status).toBe(400);
    expect((await create({ name: 'x', job_number: 5 })).status).toBe(400);
    expect((await create({ name: 'Cross' }, f.employeeA.cookies, 'https://evil.example')).status).toBe(403);
    expect((await create({ name: 'Anonymous' }, [])).status).toBe(401);
    await gate(false);
    expect((await create({ name: 'Closed' })).status).toBe(503);
    await gate(true);
  });
});
