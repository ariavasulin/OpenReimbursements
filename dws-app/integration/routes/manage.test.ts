import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
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

import { GET as listJobs } from '@/app/api/photo-jobs/route';
import { PATCH as patchJob, DELETE as deleteJob } from '@/app/api/photo-jobs/[id]/route';
import { PATCH as patchPhoto } from '@/app/api/photos/[id]/route';
import { GET as listTrash } from '@/app/api/photos/trash/route';
import { POST as purge } from '@/app/api/photos/trash/purge/route';

// Rename a photo, renumber, delete, and restore a project, and delete Trash
// forever through the real routes, with real Storage objects.
describe('managing routes: rename, delete a project, delete forever', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const origin = 'http://localhost:3000';
  const made: string[] = [];
  const call = async (handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
    method: string, path: string, body?: unknown, id = '') => {
    const request = new Request(`${origin}${path}`, { method,
      headers: body === undefined ? { origin } : { origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const response = await withRequest(request, f.employeeA.cookies, () => handler(request, { params: Promise.resolve({ id }) }));
    return { status: response.status, body: await response.json() };
  };
  const job = async (number = randomUUID().slice(0, 8)) => {
    const created = await f.admin.rpc('photo_create_job', { p_actor: f.employeeB.id, p_name: 'Route fixture', p_job_number: number });
    expect(created.error).toBeNull();
    return created.data.job as { id: string; job_number: string };
  };
  /** A photo with a real original and thumbnail in Storage. */
  async function photo(jobId: string | null, trashed = false) {
    const id = randomUUID(); const now = Date.now();
    const original = `originals/${f.employeeB.id}/${id}/route.jpg`, thumb = `derived/${f.employeeB.id}/${id}_thumb.webp`;
    for (const path of [original, thumb]) {
      expect((await f.admin.storage.from('photos').upload(path, new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' })).error).toBeNull();
    }
    const inserted = await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeB.id, kind: 'image',
      captured_at: new Date(now).toISOString(), original_path: original, thumb_path: thumb, original_name: 'route.jpg',
      ...(trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id,
        purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    made.push(original, thumb);
    return { id, original, thumb };
  }
  const stored = async (path: string) => (await f.admin.storage.from('photos').exists(path)).data;

  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true })).error).toBeNull();
  });
  afterAll(async () => {
    if (f) { await f.admin.storage.from('photos').remove(made); await f.close(); }
  });

  it('renames a photo, and an empty name goes back to the uploaded filename', async () => {
    const { id } = await photo(null);
    const renamed = await call(patchPhoto, 'PATCH', `/api/photos/${id}`, { display_name: '  Kitchen   before ' }, id);
    expect(renamed).toMatchObject({ status: 200, body: { photo: { display_name: 'Kitchen before', original_name: 'route.jpg' } } });
    expect(await call(patchPhoto, 'PATCH', `/api/photos/${id}`, { display_name: 'a/b' }, id)).toMatchObject({ status: 400, body: { error: { code: 'photo_name_invalid' } } });
    expect((await call(patchPhoto, 'PATCH', `/api/photos/${id}`, { display_name: '' }, id)).body.photo.display_name).toBeNull();
  });

  it('renames a project and its number; a taken number is a clear 409', async () => {
    const [a, b] = [await job(), await job()];
    const renamed = await call(patchJob, 'PATCH', `/api/photo-jobs/${a.id}`, { name: 'Renamed', job_number: `${a.job_number}-2` }, a.id);
    expect(renamed).toMatchObject({ status: 200, body: { job: { name: 'Renamed', job_number: `${a.job_number}-2` } } });
    const taken = await call(patchJob, 'PATCH', `/api/photo-jobs/${a.id}`, { name: 'Renamed', job_number: b.job_number }, a.id);
    expect(taken).toMatchObject({ status: 409, body: { error: { code: 'job_number_taken', message: 'Another project already uses that number.' } } });
    expect((await call(patchJob, 'PATCH', `/api/photo-jobs/${a.id}`, { name: 'Renamed', job_number: 'P-9' }, a.id)).body.error.code).toBe('job_number_reserved');
  });

  it('deletes a project to Trash with its photos, lists it, and restores both', async () => {
    const project = await job();
    const { id } = await photo(project.id);
    expect(await call(deleteJob, 'DELETE', `/api/photo-jobs/${project.id}`, undefined, project.id)).toMatchObject({ status: 200, body: { trashed: 1 } });
    const deleted = await call(listJobs, 'GET', '/api/photo-jobs?deleted=1');
    expect(deleted.body.jobs.find((row: { id: string }) => row.id === project.id)).toMatchObject({ photo_count: 1, job_number: project.job_number });
    const restored = await call(patchJob, 'PATCH', `/api/photo-jobs/${project.id}`, { action: 'restore' }, project.id);
    expect(restored).toMatchObject({ status: 200, body: { restored: 1, job: { is_active: true } } });
    expect((await f.sql.query('select deleted_at from public.photos where id=$1', [id])).rows[0].deleted_at).toBeNull();
  });

  it('deletes photos forever: files removed from Storage, rows gone, out of the Trash list at once', async () => {
    const trashed = await photo(null, true);
    const active = await photo(null);
    const result = await call(purge, 'POST', '/api/photos/trash/purge', { photo_ids: [trashed.id, active.id] });
    expect(result).toMatchObject({ status: 200, body: { marked: { photos: 1 }, purged: 1, remaining: 0, failed: 0 } });
    expect(await stored(trashed.original)).toBe(false);
    expect(await stored(trashed.thumb)).toBe(false);
    expect(await stored(active.original)).toBe(true);
    expect((await f.sql.query('select 1 from public.photos where id=$1', [trashed.id])).rowCount).toBe(0);
    const listed = await call(listTrash, 'GET', '/api/photos/trash?limit=100');
    expect(listed.body.photos.some((row: { id: string }) => row.id === trashed.id)).toBe(false);
  });

  it('empties the whole Trash, a deleted project with it', async () => {
    const project = await job();
    const inProject = await photo(project.id);
    const loose = await photo(null, true);
    await call(deleteJob, 'DELETE', `/api/photo-jobs/${project.id}`, undefined, project.id);
    const result = await call(purge, 'POST', '/api/photos/trash/purge', { everything: true });
    expect(result.status).toBe(200);
    expect(result.body.marked.projects).toBeGreaterThanOrEqual(1);
    for (const path of [inProject.original, loose.original]) expect(await stored(path)).toBe(false);
    expect((await call(listJobs, 'GET', '/api/photo-jobs?deleted=1')).body.jobs.some((row: { id: string }) => row.id === project.id)).toBe(false);
    // Its number is free again.
    expect((await f.admin.rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Again', p_job_number: project.job_number })).data.status).toBe('created');
  });

  it('photos left marked by a cut-off request are counted in Trash and finished by an empty request', async () => {
    const trashed = await photo(null, true);
    // A request that marked the photo and then stopped before removing its files.
    expect((await f.admin.rpc('photo_purge_request', { p_actor: f.employeeA.id, p_photo_ids: [trashed.id] })).error).toBeNull();
    const before = await call(listTrash, 'GET', '/api/photos/trash?limit=100');
    expect(before.body.pending_purge).toBeGreaterThanOrEqual(1);
    expect(before.body.photos.some((row: { id: string }) => row.id === trashed.id)).toBe(false);
    const finished = await call(purge, 'POST', '/api/photos/trash/purge', {});
    expect(finished).toMatchObject({ status: 200, body: { marked: { photos: 0 }, remaining: 0, failed: 0 } });
    expect(await stored(trashed.original)).toBe(false);
    expect((await call(listTrash, 'GET', '/api/photos/trash?limit=100')).body.pending_purge).toBe(0);
  });

  it('lists a project in Trash past its 30 days, with Delete forever still possible', async () => {
    const project = await job();
    await call(deleteJob, 'DELETE', `/api/photo-jobs/${project.id}`, undefined, project.id);
    await f.sql.query("update public.jobs set deleted_at=deleted_at-interval '31 days' where id=$1", [project.id]);
    const listed = (await call(listJobs, 'GET', '/api/photo-jobs?deleted=1')).body;
    expect(listed.truncated).toBe(false);
    const row = listed.jobs.find((item: { id: string }) => item.id === project.id);
    expect(Date.parse(row.restore_before)).toBeLessThan(Date.now());
    expect((await call(purge, 'POST', '/api/photos/trash/purge', { project_ids: [project.id] })).body.marked.projects).toBe(1);
  });

  it('refuses a bad purge body and a cross-site request', async () => {
    expect((await call(purge, 'POST', '/api/photos/trash/purge', { everything: false })).status).toBe(400);
    expect((await call(purge, 'POST', '/api/photos/trash/purge', { photo_ids: ['not-a-uuid'] })).status).toBe(400);
    const request = new Request(`${origin}/api/photos/trash/purge`, { method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ everything: true }) });
    expect((await withRequest(request, f.employeeA.cookies, () => purge(request))).status).toBe(403);
  });
});
