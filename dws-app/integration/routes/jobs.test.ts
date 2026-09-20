import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { withRequest } from './request-context';

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

import { POST as createJob } from '@/app/api/photo-jobs/route';
import { PATCH as renameJob } from '@/app/api/photo-jobs/[id]/route';

describe('hand-made project routes (photo-folders AC-2, AC-3, AC-5, AC-6)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'https://photos.example.test';
  const gate = async (open: boolean) =>
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: open }).eq('singleton', true)).error).toBeNull();
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
