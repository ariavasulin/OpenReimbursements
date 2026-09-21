import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';
vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return { cookies: async () => ({ get: (name: string) => {
    const value = requestContext.getStore()!.cookies.get(name); return value === undefined ? undefined : { name, value };
  }, set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); } }),
  headers: async () => requestContext.getStore()!.headers };
});
import { GET as shareStatus, PUT as shareSwitch } from '@/app/api/photo-share/route';
import { GET as publicRead } from '@/app/api/share/[token]/route';
import { GET as photosList } from '@/app/api/photos/route';

// plans/active/photo-albums/plan.md, Phase 7 (AC-21, AC-22) through the real route handlers, and the
// rendered /s/<token> page fetched signed out from this suite's real Next server. The public route
// is the only one in the app with no login, so these cases try to get more out of it than they should.
describe('share link routes (photo-albums AC-21, AC-22)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const tag = randomUUID().slice(0, 8);
  const UPLOADER = `Quentin Uploader-${tag}`, SECRET_TAG = `secret-tag-${tag}`;
  const origin = process.env.DWS_BROWSER_ORIGIN!;
  let project: string;
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
    await f.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', [UPLOADER, f.employeeB.id]);
    project = (await f.admin.from('jobs').insert({ job_number: `share-routes-${tag}`, name: `Harbour House ${tag}` }).select('id').single()).data!.id;
  });
  beforeEach(async () => { await f.sql.query('update public.photo_release_state set sharing_enabled=true,photo_writes_enabled=true'); });
  afterAll(async () => { await f.sql.query('update public.photo_release_state set sharing_enabled=false'); await f?.close(); });

  function signedIn<T>(handler: (request: Request) => Promise<T>, url: string, init: { method?: string; body?: unknown; actor?: FixtureActor | null; origin?: string } = {}) {
    const request = new Request(`http://localhost:3000${url}`, { method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Origin: init.origin ?? 'http://localhost:3000' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const actor = init.actor === undefined ? f.employeeA : init.actor;
    return withRequest(request, actor?.cookies ?? [], () => handler(request));
  }
  const turn = async (target: object, enabled: boolean, init: Parameters<typeof signedIn>[2] = {}) => signedIn(shareSwitch, '/api/photo-share', { method: 'PUT', body: { ...target, enabled }, ...init });
  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
  /** The public route, called the way a stranger calls it: no cookies at all. */
  const visit = (token: string, query = '') => publicRead(new Request(`http://localhost:3000/api/share/${token}${query}`), { params: Promise.resolve({ token }) });
  const album = async (name: string) => (await f.admin.rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: name })).data.album.id as string;
  let clock = Date.UTC(2026, 1, 1);
  async function photo(options: { albums?: string[]; jobId?: string | null; trashed?: boolean; name?: string } = {}) {
    const id = randomUUID(); clock += 60_000; const at = new Date(clock).toISOString();
    expect((await f.admin.from('photos').insert({ id, job_id: options.jobId ?? null, uploader_id: f.employeeB.id, kind: 'image', captured_at: at, tags: [SECRET_TAG],
      original_name: options.name ?? `IMG_${id.slice(0, 6)}.jpg`, mime_type: 'image/jpeg', original_path: `originals/${f.employeeB.id}/${id}/photo.jpg`,
      thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`, preview_path: `derived/${f.employeeB.id}/${id}_preview.webp`,
      sidecar_path: `originals/${f.employeeB.id}/${id}/photo.xmp`, sidecar_name: 'photo.xmp',
      ...(options.trashed ? { deleted_at: at, deleted_by: f.employeeB.id, purge_after: new Date(clock + 30 * 86_400_000).toISOString() } : {}) })).error).toBeNull();
    for (const albumId of options.albums ?? []) await f.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [albumId, id, f.employeeA.id]);
    return id;
  }
  /** The API route sends exactly `no-store`. A rendered page gets `must-revalidate` added by Next itself, so for a
   * page what matters is asserted instead: `no-store` is there, and nothing that would let a shared cache keep it. */
  const expectHeaders = (response: Response, page = false) => {
    const cache = response.headers.get('cache-control') ?? '';
    if (page) { expect(cache).toContain('no-store'); expect(cache).not.toMatch(/public|s-maxage|max-age=[1-9]/); }
    else expect(cache).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  };

  it('AC-21: turning sharing on gives a link on the public photos address; signed out it shows the name, count, and photos to view and download', async () => {
    const a = await album(`Client album ${tag}`); const one = await photo({ albums: [a], name: 'kitchen.jpg' }), two = await photo({ albums: [a], jobId: project });
    const on = await turn({ album_id: a }, true); expect(on.status).toBe(200);
    const link = await on.json() as { enabled: boolean; url: string };
    expect(link.enabled).toBe(true);
    expect(link.url).toMatch(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s/[A-Za-z0-9_-]{43}$`));
    // Shown again whenever the pop-up opens, to any employee.
    expect(await (await signedIn(shareStatus, `/api/photo-share?album=${a}`, { actor: f.employeeB })).json()).toMatchObject({ enabled: true, url: link.url, pages_open: true });
    const response = await visit(tokenOf(link.url)); expect(response.status).toBe(200); expectHeaders(response);
    const page = await response.json();
    expect(page).toMatchObject({ kind: 'album', name: `Client album ${tag}`, count: 2, next: null });
    expect(page.photos.map((row: { id: string }) => row.id)).toEqual([two, one]);
    for (const row of page.photos) {
      expect(Object.keys(row).sort()).toEqual(['captured_at', 'download_url', 'duration_secs', 'id', 'kind', 'name', 'preview_url', 'thumb_url', 'video_url']);
      expect(row.thumb_url).toContain('/storage/v1/object/public/photos/derived/'); expect(row.download_url).toContain('download=');
    }
    // No uploader name, tag, XMP, other album, project, or link bookkeeping anywhere in the body.
    const text = JSON.stringify(page).toLowerCase();
    for (const secret of [UPLOADER, 'quentin', SECRET_TAG, '.xmp', 'sidecar', 'uploader', 'tags', 'job', `share-routes-${tag}`, 'harbour house', 'token', 'created_by']) expect(text, secret).not.toContain(secret.toLowerCase());
  });

  it('AC-22: off is a 404 at once; on again is a NEW link and the old one stays dead; every dead link is the SAME 404', async () => {
    const a = await album(`Switch ${tag}`); await photo({ albums: [a] });
    const first = tokenOf((await (await turn({ album_id: a }, true)).json()).url);
    expect((await visit(first)).status).toBe(200);
    expect(await (await turn({ album_id: a }, false, { actor: f.employeeB })).json()).toEqual({ enabled: false, url: null, created_at: null });
    const revoked = await visit(first); expect(revoked.status).toBe(404); expectHeaders(revoked);
    const second = tokenOf((await (await turn({ album_id: a }, true)).json()).url);
    expect(second).not.toBe(first); expect((await visit(second)).status).toBe(200); expect((await visit(first)).status).toBe(404);

    const unknown = await visit(Buffer.from(randomUUID() + randomUUID()).subarray(0, 32).toString('base64url'));
    await f.sql.query('update public.photo_release_state set sharing_enabled=false');
    const gateClosed = await visit(second);
    await f.sql.query('update public.photo_release_state set sharing_enabled=true');
    const malformed = await visit('not-a-token'), injected = await visit(encodeURIComponent("' or 1=1 --")), badCursor = await visit(second, '?after=%7B%7D');
    const bodies = new Set<string>();
    for (const dead of [revoked, unknown, gateClosed, malformed, injected, badCursor]) {
      expect(dead.status).toBe(404); expectHeaders(dead);
      expect(dead.headers.get('vary')).toBeNull(); // not the signed-in routes' `Vary: Cookie`
    }
    for (const dead of [await visit(first), unknown, gateClosed, malformed, injected, badCursor]) bodies.add(await dead.clone().text().catch(() => 'consumed'));
    bodies.delete('consumed');
    expect([...bodies]).toEqual(['{"error":{"code":"not_found","message":"This link is not available."}}']);
  });

  it('AC-22: album A’s link never lists a photo only in album B, a trashed photo, or a photo in no album', async () => {
    const a = await album(`Album A ${tag}`), b = await album(`Album B ${tag}`);
    const inA = await photo({ albums: [a] }), onlyB = await photo({ albums: [b] }), trashedInA = await photo({ albums: [a], trashed: true }), loose = await photo({ jobId: project });
    const token = tokenOf((await (await turn({ album_id: a }, true)).json()).url);
    const page = await (await visit(token)).json();
    expect(page.count).toBe(1); expect(page.photos.map((row: { id: string }) => row.id)).toEqual([inA]);
    const text = JSON.stringify(page);
    for (const forbidden of [onlyB, trashedInA, loose, `Album B ${tag}`]) expect(text).not.toContain(forbidden);
    // Nothing in the request can widen it: the target comes from the token alone.
    for (const query of [`?album=${b}`, `?album_id=${b}`, `?job=${project}`, `?photo=${onlyB}`, `?p_album=${b}`]) {
      const widened = await (await visit(token, query)).json();
      expect(widened.photos.map((row: { id: string }) => row.id), query).toEqual([inA]);
    }
  });

  it('AC-22: with sharing switched off for everyone, every share page is gone while the signed-in app is unaffected', async () => {
    const token = tokenOf((await (await turn({ job_id: project }, true)).json()).url); await photo({ jobId: project });
    expect((await visit(token)).status).toBe(200);
    await f.sql.query('update public.photo_release_state set sharing_enabled=false');
    expect((await visit(token)).status).toBe(404);
    const app = await signedIn(photosList, `/api/photos?job=${project}`); expect(app.status).toBe(200);
    expect((await app.json()).photos.length).toBeGreaterThan(0);
    // An employee can still see and flip the switch, and is told the pages are closed.
    expect(await (await signedIn(shareStatus, `/api/photo-share?job=${project}`)).json()).toMatchObject({ enabled: true, pages_open: false });
    expect((await turn({ job_id: project }, false)).status).toBe(200);
  });

  it('inactive projects return the unavailable result from both public API and page', async () => {
    const name = `Inactive project ${tag}`;
    const made = await f.admin.from('jobs').insert({ job_number: `inactive-routes-${tag}`, name, is_active: true }).select('id').single();
    expect(made.error).toBeNull(); const id = made.data!.id as string;
    await photo({ jobId: id });
    const url = (await (await turn({ job_id: id }, true)).json()).url as string;
    expect((await visit(tokenOf(url))).status).toBe(200);
    await f.sql.query('update public.jobs set is_active=false where id=$1', [id]);
    const api = await visit(tokenOf(url));
    expect(api.status).toBe(404); expectHeaders(api);
    expect(await api.text()).toBe(await (await visit('missing')).text());
    const page = await fetch(url, { redirect: 'manual' });
    expect(page.status).toBe(404); expectHeaders(page, true);
    expect(await page.text()).not.toContain(name);
  });

  it('the switch is for signed-in employees only, from this site only, and takes exactly one target', async () => {
    const a = await album(`Guarded ${tag}`);
    expect((await turn({ album_id: a }, true, { actor: null })).status).toBe(401);
    expect((await signedIn(shareStatus, `/api/photo-share?album=${a}`, { actor: null })).status).toBe(401);
    expect((await turn({ album_id: a }, true, { origin: 'https://evil.example' })).status).toBe(403);
    for (const bad of [{}, { album_id: a, job_id: project }, { album_id: 'nope' }, { album_id: a, extra: 1 }]) expect((await turn(bad, true)).status, JSON.stringify(bad)).toBe(400);
    expect((await signedIn(shareSwitch, '/api/photo-share', { method: 'PUT', body: { album_id: a, enabled: 'yes' } })).status).toBe(400);
    expect((await turn({ album_id: randomUUID() }, true)).status).toBe(404);
    expect((await signedIn(shareStatus, `/api/photo-share?album=${a}&job=${project}`)).status).toBe(400);
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=false');
    expect((await turn({ album_id: a }, true)).status).toBe(503);
  });

  it('AC-21/AC-22: the PAGE itself, fetched signed out: a live link is 200 with the name and photos and no private detail; a dead one is a real 404; both send the headers', async () => {
    const a = await album(`Rendered album ${tag}`); await photo({ albums: [a], name: 'rendered.jpg' });
    const url = (await (await turn({ album_id: a }, true)).json()).url as string;
    const live = await fetch(url, { redirect: 'manual' }); expect(live.status).toBe(200); expectHeaders(live, true);
    expect(live.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await live.text();
    expect(html).toContain(`Rendered album ${tag}`); expect(html).toContain('/storage/v1/object/public/photos/derived/');
    expect(html).toMatch(/<meta name="robots" content="[^"]*noindex/);
    for (const secret of [UPLOADER, 'Quentin', SECRET_TAG, '.xmp', 'sidecar']) expect(html, secret).not.toContain(secret);
    // No app chrome: none of the signed-in app's navigation is on this page.
    for (const chrome of ['Sign out', 'href="/photos"', 'Import folders', 'Trash']) expect(html, chrome).not.toContain(chrome);
    expect((await turn({ album_id: a }, false)).status).toBe(200);
    for (const dead of [url, `${origin}/s/${'A'.repeat(43)}`, `${origin}/s/nope`]) {
      const response = await fetch(dead, { redirect: 'manual' }); expect(response.status, dead).toBe(404); expectHeaders(response, true);
      const body = await response.text(); expect(body).toContain('This link is not available'); expect(body).not.toContain(`Rendered album ${tag}`);
    }
  });
});
