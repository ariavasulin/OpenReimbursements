import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { POST as consume } from '@/app/api/photo-migrations/handoffs/consume/route';
import { GET as trash } from '@/app/api/photos/trash/route';
import { GET as dedupe } from '@/app/api/photos/dedupe/route';
import { GET as ownership } from '@/app/api/photos/[id]/ownership/route';
import { GET as migrationBatch } from '@/app/api/photo-migrations/batches/[id]/route';
import { GET as actionBatch } from '@/app/api/photo-actions/batches/[id]/route';
import { requirePhotoActor, assertPhotoBatchActor } from '@/lib/photos/server/authority';
import { AUTH_COOKIE_NAME } from '@/lib/cookieDomain';

describe('authenticated photo routes against isolated Auth and PostgREST (AC-2, AC-8, AC-9, AC-14)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  const activeId = randomUUID();
  const trashId = randomUUID();
  const expiredId = randomUUID();
  const legacyId = randomUUID();
  const digest = randomBytes(32).toString('hex');
  const expiredDigest = randomBytes(32).toString('hex');

  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `routes-${jobId}`, name: 'Route fixtures' })).error).toBeNull();
    const now = Date.now();
    const rows = [
      { id: activeId, content_sha256: randomBytes(32).toString('hex') },
      { id: trashId, content_sha256: digest, deleted_at: new Date(now - 86_400_000).toISOString(),
        deleted_by: f.employeeA.id, purge_after: new Date(now + 29 * 86_400_000).toISOString() },
      { id: expiredId, content_sha256: expiredDigest, deleted_at: new Date(now - 31 * 86_400_000).toISOString(),
        deleted_by: f.employeeA.id, purge_after: new Date(now - 86_400_000).toISOString() },
    ].map(row => ({ job_id: jobId, uploader_id: f.employeeA.id, kind: 'image', captured_at: new Date(now).toISOString(),
      original_path: `originals/${f.employeeA.id}/${row.id}/fixture.jpg`, original_bytes: 4,
      original_name: `${row.id}.jpg`, ...row }));
    expect((await f.admin.from('photos').insert(rows)).error).toBeNull();
    expect((await f.admin.from('photos').insert({ ...rows[1], id: legacyId, duplicate_of: trashId,
      content_sha256: null, legacy_content_sha256: digest })).error).toBeNull();
  });
  beforeEach(async () => {
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true,
      schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
  });
  afterAll(async () => { await f?.close(); });

  const get = (path: string) => new Request(`http://localhost:3000${path}`);
  const post = (body: unknown, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/photo-migrations/handoffs/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  async function handoff(script = 'migrate_photos', expires = Date.now() + 60_000) {
    const token = randomBytes(32).toString('base64url');
    expect((await f.admin.from('dws_action_handoffs').insert({
      token_digest: createHash('sha256').update(token).digest('hex'), script_name: script,
      expires_at: new Date(expires).toISOString(), requested_input: {},
    })).error).toBeNull();
    return token;
  }
  function invoke<T>(request: Request, work: () => T, actor = f.employeeA) {
    return withRequest(request, actor.cookies, work);
  }
  async function assertError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ error: { code, message: expect.any(String), retryable: status === 503 || status === 429 } });
  }

  it('requires a verified session for every privileged read and handoff', async () => {
    const routes = [
      [get('/api/photos/trash'), (r: Request) => trash(r)],
      [get(`/api/photos/dedupe?sha256=${digest}`), (r: Request) => dedupe(r)],
      [get(`/api/photos/${trashId}/ownership`), (r: Request) => ownership(r, { params: Promise.resolve({ id: trashId }) })],
      [post({ token: await handoff(), script_name: 'migrate_photos' }), (r: Request) => consume(r)],
    ] as const;
    for (const [request, handler] of routes) {
      await assertError(await withRequest(request, [], () => handler(request)), 401, 'unauthenticated');
    }
  });

  it('rejects a forged session cookie instead of trusting its locally decoded user', async () => {
    const cookie = f.employeeA.cookies.find(c => c.name.startsWith(AUTH_COOKIE_NAME) &&!c.name.endsWith('.1'))!;
    const baseName = cookie.name.replace(/\.0$/, '');
    const combined = f.employeeA.cookies.filter(c => c.name === baseName || c.name.startsWith(`${baseName}.`))
      .sort((a, b) => a.name.localeCompare(b.name)).map(c => c.value).join('');
    const session = JSON.parse(Buffer.from(combined.replace(/^base64-/, ''), 'base64url').toString());
    const jwt = session.access_token.split('.');
    const payload = JSON.parse(Buffer.from(jwt[1], 'base64url').toString());
    jwt[1] = Buffer.from(JSON.stringify({ ...payload, sub: f.employeeB.id })).toString('base64url');
    session.access_token = jwt.join('.');
    const request = get('/api/photos/trash');
    const cookies = [{ name: baseName, value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }];
    await assertError(await withRequest(request, cookies, () => trash(request)), 401, 'unauthenticated');
  });

  it('denies a deactivated employee even while their Auth cookie is otherwise valid', async () => {
    await f.sql.query('update public.user_profiles set deleted_at=now() where user_id=$1', [f.employeeB.id]);
    try {
      const request = get('/api/photos/trash');
      await assertError(await invoke(request, () => trash(request), f.employeeB), 403, 'forbidden');
    } finally {
      await f.sql.query('update public.user_profiles set deleted_at=null where user_id=$1', [f.employeeB.id]);
    }
  });

  it('denies an Auth-banned employee with an otherwise active profile', async () => {
    await f.sql.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [f.employeeB.id]);
    try {
      const request = get('/api/photos/trash');
      await assertError(await invoke(request, () => trash(request), f.employeeB), 401, 'unauthenticated');
    } finally {
      await f.sql.query('update auth.users set banned_until=null where id=$1', [f.employeeB.id]);
    }
  });

  it('rejects cross-origin, missing-origin and oversized mutations without consuming a token', async () => {
    const token = await handoff();
    for (const origin of ['https://attacker.example', 'null', '']) {
      const request = post({ token, script_name: 'migrate_photos' }, origin);
      await assertError(await invoke(request, () => consume(request)), 403, 'forbidden');
    }
    const large = post({ token, script_name: 'migrate_photos', extra: 'x'.repeat(17_000) });
    await assertError(await invoke(large, () => consume(large)), 413, 'payload_too_large');
    const valid = post({ token, script_name: 'migrate_photos' });
    expect((await invoke(valid, () => consume(valid))).status).toBe(200);
  });

  it('consumes once under concurrent real route requests and resumes by authenticated batch ID', async () => {
    const token = await handoff();
    const requests = [post({ token, script_name: 'migrate_photos' }), post({ token, script_name: 'migrate_photos' })];
    const responses = await Promise.all(requests.map(request => invoke(request, () => consume(request))));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const result = await responses.find(r => r.status === 200)!.json();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.migration_batch_id).toEqual(expect.any(String));
    expect(result.photo_action_batch_id).toBeNull();
    const request = get(`/api/photo-migrations/batches/${result.migration_batch_id}`);
    for (const actor of [f.employeeA, f.employeeB]) {
      const response = await invoke(request, () => migrationBatch(request, { params: Promise.resolve({ id: result.migration_batch_id }) }), actor);
      expect(response.status).toBe(200);
      expect((await response.json()).can_mutate).toBe(actor.id === f.employeeA.id);
    }
  });

  it('rejects expired handoffs and script substitution without leaking the token', async () => {
    const expired = post({ token: await handoff('migrate_photos', Date.now() - 1000), script_name: 'migrate_photos' });
    await assertError(await invoke(expired, () => consume(expired)), 410, 'handoff_expired');
    const token = await handoff();
    const wrong = post({ token, script_name: 'remove_photos' });
    await assertError(await invoke(wrong, () => consume(wrong)), 403, 'forbidden');
    const correct = post({ token, script_name: 'migrate_photos' });
    expect((await invoke(correct, () => consume(correct))).status).toBe(200);
  });

  it('binds action authority to consumer and script even when another employee can inspect progress', async () => {
    const request = post({ token: await handoff('remove_photos'), script_name: 'remove_photos' });
    const response = await invoke(request, () => consume(request));
    expect(response.status).toBe(200);
    const { photo_action_batch_id: id } = await response.json();
    const read = get(`/api/photo-actions/batches/${id}`);
    const other = await invoke(read, () => actionBatch(read, { params: Promise.resolve({ id }) }), f.employeeB);
    expect(other.status).toBe(200);
    expect((await other.json()).can_mutate).toBe(false);
    await invoke(read, async () => {
      const actor = await requirePhotoActor(read);
      await assertPhotoBatchActor(actor, id, 'action', 'trash');
      await expect(assertPhotoBatchActor(actor, id, 'action', 'restore')).rejects.toMatchObject({ code: 'forbidden' });
    });
    await invoke(read, async () => {
      const actor = await requirePhotoActor(read);
      await expect(assertPhotoBatchActor(actor, id, 'action', 'trash')).rejects.toMatchObject({ code: 'forbidden' });
    }, f.employeeB);
  });

  it('trash contains only unexpired rows; digest and ownership deliberately include retained rows', async () => {
    const request = get(`/api/photos/trash?job_id=${jobId}&limit=1`);
    const first = await invoke(request, () => trash(request));
    expect(first.headers.get('cache-control')).toBe('no-store');
    const page = await first.json();
    expect(page.photos).toHaveLength(1);
    expect(page.next_cursor).toEqual(expect.any(String));
    const next = get(`/api/photos/trash?job_id=${jobId}&limit=1&after=${page.next_cursor}`);
    const finalPage = await (await invoke(next, () => trash(next))).json();
    expect([...page.photos, ...finalPage.photos].map(row => row.id).sort()).toEqual([trashId, legacyId].sort());
    expect(finalPage.next_cursor).toBeNull();
    for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
      const lookup = get(`/api/photos/dedupe?sha256=${digest}`);
      const result = await (await invoke(lookup, () => dedupe(lookup), actor)).json();
      expect(result).toMatchObject({ status: 'duplicate_trashed', photo_id: trashId,
        can_restore: actor.id !== f.employeeB.id });
      if (actor.id === f.employeeB.id) expect(result.remedy).toContain('MCP restore handoff');
    }
    const retained = get(`/api/photos/${expiredId}/ownership`);
    const owner = await (await invoke(retained, () => ownership(retained, { params: Promise.resolve({ id: expiredId }) }))).json();
    expect(owner).toMatchObject({ photo_id: expiredId, uploader_id: f.employeeA.id, can_restore: false });
    expect(owner).not.toHaveProperty('original_path');
    const expiredLookup = get(`/api/photos/dedupe?sha256=${expiredDigest}`);
    expect(await (await invoke(expiredLookup, () => dedupe(expiredLookup))).json()).toMatchObject({
      status: 'duplicate_trashed', photo_id: expiredId, can_restore: false,
      remedy: expect.stringMatching(/cleanup.*retry|retry.*cleanup/i),
    });
  });

  it('fails closed on missing, closed, and incompatible gate records', async () => {
    for (const update of [{ photo_writes_enabled: false }, { schema_generation: 2 }]) {
      expect((await f.admin.from('photo_release_state').update(update).eq('singleton', true)).error).toBeNull();
      const request = get('/api/photos/trash');
      await assertError(await invoke(request, () => trash(request)), 503, 'temporarily_unavailable');
      expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true, schema_generation: 1 }).eq('singleton', true)).error).toBeNull();
    }
    expect((await f.admin.from('photo_release_state').update({ mcp_enabled: false }).eq('singleton', true)).error).toBeNull();
    const request = post({ token: await handoff(), script_name: 'migrate_photos' });
    await assertError(await invoke(request, () => consume(request)), 503, 'temporarily_unavailable');
    expect((await f.admin.from('photo_release_state').delete().eq('singleton', true)).error).toBeNull();
    const read = get('/api/photos/trash');
    await assertError(await invoke(read, () => trash(read)), 503, 'temporarily_unavailable');
  });
});
