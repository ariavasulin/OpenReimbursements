import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

import { GET as list } from '@/app/api/photos/route';
import { GET as tags } from '@/app/api/photo-tags/route';
import { GET as jobs } from '@/app/api/photo-jobs/route';
import { GET as trash } from '@/app/api/photos/trash/route';
import { GET as dedupe } from '@/app/api/photos/dedupe/route';
import { POST as repair } from '@/app/api/photos/repair/route';

describe('active library boundaries with retained photo identities (AC-9)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  const jobNumber = `read-${jobId}`;
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const digest = randomBytes(32).toString('hex');
  const expiredDigest = randomBytes(32).toString('hex');
  const uniqueTag = `retained-${randomUUID()}`;
  const original = new Uint8Array([137, 80, 78, 71]);
  let retainedPath: string;

  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query(`insert into public.photo_release_state(singleton,photo_writes_enabled,mcp_enabled,repair_enabled,schema_generation)
      values(true,true,true,true,1) on conflict(singleton) do update
      set photo_writes_enabled=true,mcp_enabled=true,repair_enabled=true,schema_generation=1`);
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: jobNumber, name: 'Read boundary fixtures' })).error).toBeNull();
    const now = Date.now();
    retainedPath = `originals/${f.employeeA.id}/${ids[1]}/retained.png`;
    expect((await f.admin.storage.from('photos').upload(retainedPath, original, { contentType: 'image/png' })).error).toBeNull();
    const rows = ids.map((id, index) => ({
      id, job_id: jobId, uploader_id: f.employeeA.id, kind: index === 2 ? 'file' : 'image', original_bytes: original.length,
      original_name: index === 0 ? `${ids[0]}.png` : index === 2 ? `${ids[0]}.xmp` : `retained-${index}.png`,
      original_path: index === 1 ? retainedPath : `originals/${f.employeeA.id}/${id}/fixture.png`,
      thumb_path: index === 0 ? `derived/${f.employeeA.id}/${id}_thumb.webp` : index === 1 ? `private-tag-${index}` : null,
      content_sha256: index === 0 ? randomBytes(32).toString('hex') : index === 1 ? digest : index === 2 ? expiredDigest : null,
      tags: index === 0 ? ['active-tag'] : [uniqueTag],
      captured_at: new Date(now + index * 1000).toISOString(),
      deleted_at: index === 0 ? null : new Date(now - (index === 2 ? 31 : 1) * 86_400_000).toISOString(),
      deleted_by: index === 0 ? null : f.employeeA.id,
      purge_after: index === 0 ? null : new Date(now + (index === 2 ? -1 : 29) * 86_400_000).toISOString(),
      duplicate_of: index === 3 ? ids[1] : null,
      legacy_content_sha256: index === 3 ? digest : null,
    }));
    expect((await f.admin.from('photos').insert(rows.slice(0, 3))).error).toBeNull();
    expect((await f.admin.from('photos').insert(rows[3])).error).toBeNull();
  });
  afterAll(async () => {
    if (f) { await f.admin.storage.from('photos').remove([retainedPath]); await f.close(); }
  });
  async function get(handler: (request: Request) => Promise<Response>, path: string, actor = f.employeeA) {
    const request = new Request(`http://localhost:3000${path}`);
    const response = await withRequest(request, actor.cookies, () => handler(request));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  it('listing, search, uploader/tag filters and the paged deep-link source expose only active rows', async () => {
    for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
      for (const query of [
        `job=${jobId}`, `job=${jobId}&uploader=${f.employeeA.id}`, `q=${jobNumber}`, `job=${jobId}&limit=1`,
      ]) {
        const result = await get(list, `/api/photos?${query}`, actor);
        expect(result.photos.map((p: { id: string }) => p.id)).toEqual([ids[0]]);
        expect(result.nextCursor).toBeNull();
      }
      expect((await get(list, `/api/photos?job=${jobId}&tags=${uniqueTag}`, actor)).photos).toEqual([]);
      expect((await get(list, `/api/photos?job=${jobId}&q=${uniqueTag}`, actor)).photos).toEqual([]);
    }
  });

  it('tag metadata and summary counts/thumbs exclude all trash through routes and invoker RPCs', async () => {
    for (const actor of [f.employeeA, f.administrator]) {
      expect((await get(tags, `/api/photo-tags?job=${jobId}`, actor)).tags).toEqual(['active-tag']);
      expect((await get(tags, `/api/photo-tags?job=${jobId}&q=${uniqueTag}`, actor)).tags).toEqual([]);
      const summaries = await get(jobs, `/api/photo-jobs?q=${jobNumber}`, actor);
      expect(summaries.jobs).toHaveLength(1);
      expect(summaries.jobs[0]).toMatchObject({ id: jobId, photo_count: 1 });
      expect(JSON.stringify(summaries)).not.toContain('private-tag');
    }
    // Explicit SQL predicates also protect an accidental service-role library call;
    // security-invoker still preserves session RLS for the ordinary routes above.
    const summary = await f.admin.rpc('get_photo_job_summaries', { search_query: jobNumber });
    expect(summary.error).toBeNull();
    expect(summary.data).toMatchObject([{ id: jobId, photo_count: 1 }]);
    const tagRows = await f.admin.rpc('get_photo_tags', { job_filter: jobId });
    expect(tagRows.error).toBeNull();
    expect(tagRows.data).toEqual([{ tag: 'active-tag' }]);
  });

  it('trash exposes unexpired canonical and legacy history while digest lookup reserves expired hashes', async () => {
    const retained = await get(trash, `/api/photos/trash?job_id=${jobId}`);
    expect(retained.photos.map((p: { id: string }) => p.id).sort()).toEqual([ids[1], ids[3]].sort());
    expect(retained.photos.find((p: { id: string }) => p.id === ids[3])).toMatchObject({ duplicate_of: ids[1] });
    const pending = await get(dedupe, `/api/photos/dedupe?sha256=${digest}`, f.employeeB);
    expect(pending).toMatchObject({ status: 'duplicate_trashed', photo_id: ids[1], can_restore: false });
    expect(pending.remedy).toContain('administrator');
    const expired = await get(dedupe, `/api/photos/dedupe?sha256=${expiredDigest}`);
    expect(expired).toMatchObject({ status: 'duplicate_trashed', photo_id: ids[2], can_restore: false });
    expect(expired.remedy).toContain('cleanup');
  });

  it('the operator sidecar script excludes a trashed XMP candidate in its actual dry run', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/attach-orphan-sidecars.mjs'], {
      env: {
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      },
    });
    expect(stdout).toContain('Dry run');
    expect(stdout).not.toContain(`${ids[0]}.xmp`);
  });

  it('the retired legacy writer refuses execute before requesting credentials or touching data', async () => {
    await expect(promisify(execFile)(process.execPath, ['scripts/attach-orphan-sidecars.mjs', '--execute'], {
      env: { NODE_ENV: 'test' },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Execution is retired') });
  });

  it('the real repair candidate/ownership scans preserve retained rows and objects', async () => {
    const before = (await f.sql.query('select * from public.photos where id=any($1::uuid[]) order by id', [ids.slice(1)])).rows;
    const oldSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'isolated-read-boundary-cron';
    try {
      const request = new Request('http://localhost:3000/api/photos/repair?olderThan=0', {
        method: 'POST', headers: { authorization: 'Bearer isolated-read-boundary-cron' },
      });
      const result = await repair(request);
      const report = await result.json();
      expect(report).toMatchObject({ counts: expect.any(Object), errors: expect.any(Array), planned: expect.any(Number) });
      // Expired and legacy rows deliberately have no thumb/original object. A
      // missing active predicate would plan and delete them as dead rows.
      expect((await f.sql.query('select * from public.photos where id=any($1::uuid[]) order by id', [ids.slice(1)])).rows).toEqual(before);
      expect((await f.admin.storage.from('photos').exists(retainedPath)).data).toBe(true);
    } finally {
      if (oldSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = oldSecret;
    }
  });

  it('a previously known public object URL remains fetchable during trash retention', async () => {
    const url = f.admin.storage.from('photos').getPublicUrl(retainedPath).data.publicUrl;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
  });
});
