import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';
vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return { cookies: async () => ({ get: (name: string) => {
    const value = requestContext.getStore()!.cookies.get(name); return value === undefined ? undefined : { name, value };
  }, set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); } }),
  headers: async () => requestContext.getStore()!.headers };
});
import { POST as create, GET as recent } from '@/app/api/photo-migrations/batches/route';
import { PATCH as action } from '@/app/api/photo-migrations/batches/[id]/route';
import { POST as source } from '@/app/api/photo-migrations/batches/[id]/sources/route';
import { GET as folders } from '@/app/api/photo-migrations/batches/[id]/folders/route';
import { PATCH as editFolders } from '@/app/api/photo-migrations/sources/[id]/folders/route';
import { POST as scan } from '@/app/api/photo-migrations/sources/[id]/scan/route';
import { POST as chunk } from '@/app/api/photo-migrations/sources/[id]/chunks/route';
import { POST as seal } from '@/app/api/photo-migrations/sources/[id]/seal/route';
import { POST as consume } from '@/app/api/photo-migrations/handoffs/consume/route';
import { GET as jobs } from '@/app/api/photo-migrations/jobs/route';

// plans/active/photo-albums/plan.md, Phase 6, through the real route handlers:
// AC-18 (loose files need a project or an album), AC-19 (MCP album_name and tags pre-fill review and
// nothing is created before the employee confirms), AC-17 (the project suggestion and the row edits).
type Row = { id: string; source_id: string; folder: string; album_name: string | null; album_id: string | null; job_id: string | null; tags: string[];
  photo_count: number; jobs: { job_number: string } | null; albums: { name: string } | null };

describe('import review routes (photo-albums AC-17, AC-18, AC-19)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const tag = randomUUID().slice(0, 8);
  const number = `71${Math.floor(Math.random() * 9000 + 1000)}`; // a project number that appears in folder names below
  let project: string;
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').upsert({ singleton: true, schema_generation: 1, photo_writes_enabled: true, mcp_enabled: true, repair_enabled: true })).error).toBeNull();
    const made = await f.admin.from('jobs').insert({ job_number: number, name: `Harbour House ${tag}` }).select('id').single();
    expect(made.error).toBeNull(); project = made.data!.id;
  });
  afterAll(async () => { await f?.close(); });

  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  async function invoke(handler: Handler, id: string, body?: unknown, options: { actor?: FixtureActor | null; method?: string; query?: string; origin?: string } = {}) {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const request = new Request(`http://localhost:3000/api/photo-migrations/test${options.query ?? ''}`, { method,
      headers: { 'Content-Type': 'application/json', Origin: options.origin ?? 'http://localhost:3000' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const actor = options.actor === undefined ? f.employeeA : options.actor;
    return withRequest(request, actor?.cookies ?? [], () => handler(request, { params: Promise.resolve({ id }) }));
  }
  async function ok(handler: Handler, id: string, body?: unknown, options: Parameters<typeof invoke>[3] = {}) {
    const response = await invoke(handler, id, body, options); const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200); return value;
  }
  const entry = (path: string) => ({ relative_path: path, original_name: path.split('/').at(-1)!, original_bytes: 9, source_mtime: 1, mime_type: 'image/jpeg', source_signature: `${path}:9:1` });
  /** Register one picked folder (or selection), read it, and seal it, exactly as the page does. */
  async function read(batchId: string, paths: string[], options: { id?: string; label?: string; kind?: string; job_id?: string | null; tags?: string[] } = {}) {
    const picked = (await ok(source, batchId, { id: options.id, job_id: options.job_id ?? null, kind: options.kind ?? 'directory', label: options.label ?? 'Office drive',
      selection_rules: { tags: options.tags ?? [] } })).source;
    const scanId = randomUUID(); await ok(scan, picked.id, { scan_id: scanId });
    const sent = await ok(chunk, picked.id, { scan_id: scanId, chunk_number: 0, entries: paths.map(entry) });
    await ok(seal, picked.id, { scan_id: scanId, chunk_count: 1, total_entries: sent.entry_count, total_bytes: sent.total_bytes, job_id: options.job_id ?? null,
      fingerprint: createHash('sha256').update(sent.payload_digest).digest('hex') });
    return picked as { id: string; label: string };
  }
  const batch = async (script = 'migrate_photos') => (await ok(create, '', { script_name: script })).batch.id as string;
  const rows = async (batchId: string): Promise<Record<string, Row>> =>
    Object.fromEntries(((await ok(folders, batchId)).folders as Row[]).map(row => [row.folder, row]));
  const edit = (sourceId: string, body: unknown, options: Parameters<typeof invoke>[3] = {}) => invoke(editFolders, sourceId, body, { method: 'PATCH', ...options });
  const approve = (batchId: string) => invoke(action, batchId, { action: 'approve' }, { method: 'PATCH' });
  const albumsNamed = async (name: string) => (await f.sql.query('select id from public.albums where name=$1', [name])).rows.length;
  /** A hand-off as the MCP mints it: only the digest is stored. */
  async function handoff(script: string, input: object) {
    const token = randomBytes(32).toString('base64url');
    expect((await f.admin.from('dws_action_handoffs').insert({ token_digest: createHash('sha256').update(token).digest('hex'), script_name: script,
      expires_at: new Date(Date.now() + 180_000).toISOString(), requested_input: input })).error).toBeNull();
    return (await ok(consume, '', { token, script_name: script })).migration_batch_id as string;
  }

  describe('AC-18: loose files need a project or an album, new or existing', () => {
    it('refuses to start with neither (400), and accepts a project, a new album, or an existing album', async () => {
      const id = await batch('add_photos'); const picked = await read(id, ['a.jpg', 'b.jpg'], { kind: 'files', label: 'Selected files' });
      expect(await rows(id)).toEqual({ '': expect.objectContaining({ album_name: null, album_id: null, job_id: null, photo_count: 2 }) });
      const refused = await approve(id);
      expect(refused.status).toBe(400); expect((await refused.json()).error.code).toBe('invalid_input');

      const name = `Christmas Party ${tag}`;
      const named = await (await edit(picked.id, { folder: '', album_name: `  ${name}  ` })).json();
      expect(named).toEqual({ updated: 1, settled: { album_name: name, album_id: null, albums: null } });
      const existing = (await f.admin.rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: `Marketing ${tag}` })).data.album.id as string;
      expect((await (await edit(picked.id, { folder: '', album_id: existing })).json()).settled).toEqual({ album_name: null, album_id: existing, albums: { id: existing, name: `Marketing ${tag}` } });
      // Clearing it again puts the refusal back; a project alone then lifts it.
      expect((await edit(picked.id, { folder: '', album_id: null })).status).toBe(200);
      expect((await approve(id)).status).toBe(400);
      expect((await (await edit(picked.id, { folder: '', job_id: project })).json()).settled).toMatchObject({ job_id: project, jobs: { job_number: number } });
      expect((await approve(id)).status).toBe(200);
      // Review created nothing: the typed album never came to exist, because it was replaced before Start.
      expect(await albumsNamed(name)).toBe(0);
    });
  });

  describe('AC-19: MCP suggestions pre-fill review, and nothing exists before the employee confirms', () => {
    it('add_photos: album_name names the album, tags arrive on the row', async () => {
      const album = `Suggested loose ${tag}`;
      const id = await handoff('add_photos', { album_name: album, tags: ['office'] });
      // The page registers the selection with the suggested tags; the album name is applied by the server at the seal.
      await read(id, ['one.jpg'], { kind: 'files', label: 'Selected files', tags: ['office'] });
      expect((await rows(id))['']).toMatchObject({ album_name: album, album_id: null, tags: ['office'], job_id: null });
      expect(await albumsNamed(album)).toBe(0);
      expect((await approve(id)).status).toBe(200);
      expect(await albumsNamed(album)).toBe(0); // confirmed, but no photo has landed yet
    });
    it('migrate_photos: a source’s album_name names only the picked folder’s own photos; sub-folders keep their paths', async () => {
      const album = `Suggested folder ${tag}`;
      const id = await handoff('migrate_photos', { sources: [{ label: 'Picked', album_name: album, tags: ['professional'] }, { label: 'Other', album_name: 'Not this one' }] });
      await read(id, ['top.jpg', 'Inside/a.jpg'], { label: 'Picked', tags: ['professional'] });
      const found = await rows(id);
      expect(found['']).toMatchObject({ album_name: album, tags: ['professional'] });
      expect(found.Inside).toMatchObject({ album_name: 'Inside', tags: ['professional'] });
      expect(await albumsNamed(album)).toBe(0);
    });
    it('a suggested album name applies once: a rescan does not bring it back after the employee renames the album', async () => {
      const id = await handoff('migrate_photos', { sources: [{ label: 'Picked', album_name: `Hinted ${tag}` }] });
      const sourceId = randomUUID();
      await read(id, ['top.jpg'], { id: sourceId, label: 'Picked' });
      expect((await edit(sourceId, { folder: '', album_name: 'My own name' })).status).toBe(200);
      await read(id, ['top.jpg', 'second.jpg'], { id: sourceId, label: 'Picked' });
      expect((await rows(id))['']).toMatchObject({ album_name: 'My own name', photo_count: 2 });
    });
    it('an import opened without a hand-off gets no suggestion from someone else’s', async () => {
      await handoff('migrate_photos', { sources: [{ label: 'Picked', album_name: `Leaked ${tag}` }] });
      const id = await batch(); await read(id, ['top.jpg'], { label: 'Picked' });
      expect((await rows(id))[''].album_name).toBe('Picked');
    });
  });

  describe('AC-17: project suggestion and row edits', () => {
    it('suggests a project from a folder name holding its number as a whole word, inherited by the folders inside', async () => {
      const id = await batch();
      await read(id, [`${number} Harbour House/Finished/a.jpg`, `${number} Harbour House/Before/Demo/b.jpg`, `x${number}y/c.jpg`, 'Christmas Party/d.jpg', 'loose.jpg']);
      const found = await rows(id);
      expect(found[`${number} Harbour House/Finished`]).toMatchObject({ job_id: project, jobs: { job_number: number } });
      expect(found[`${number} Harbour House/Before/Demo`]).toMatchObject({ job_id: project });
      // Not a whole word; no number at all; the picked folder itself.
      for (const folder of [`x${number}y`, 'Christmas Party', '']) expect(found[folder], folder).toMatchObject({ job_id: null, jobs: null });
    });
    it('the MCP hint wins: a source with a project gives every row that project and reads no folder names', async () => {
      const other = (await f.admin.from('jobs').insert({ job_number: `hint-${tag}`, name: 'Hinted project' }).select('id').single()).data!.id as string;
      const id = await batch(); await read(id, [`${number} Harbour House/a.jpg`, 'Party/b.jpg'], { job_id: other });
      for (const row of Object.values(await rows(id))) expect(row.job_id).toBe(other);
    });
    it('a choice on a top-level folder reaches the folders inside it, and the answer carries the settled values', async () => {
      const id = await batch(); const picked = await read(id, ['Smith/Finished/a.jpg', 'Smith/Before/b.jpg', 'Smith, Jones (shared)/c.jpg', 'Smithson/d.jpg']);
      const stored = `kitchen-${tag}`;
      expect((await f.admin.from('photos').insert({ id: randomUUID(), job_id: project, uploader_id: f.employeeB.id, kind: 'image', captured_at: new Date().toISOString(),
        tags: [stored], original_path: `originals/${f.employeeB.id}/${randomUUID()}/fixture.jpg` })).error).toBeNull();
      const answer = await (await edit(picked.id, { folder: 'Smith', include_subfolders: true, job_id: project, tags: [stored.toUpperCase()] })).json();
      // Two rows, and the tag took the spelling already in use.
      expect(answer).toEqual({ updated: 2, settled: { job_id: project, jobs: { id: project, job_number: number, name: `Harbour House ${tag}` }, tags: [stored] } });
      const found = await rows(id);
      for (const folder of ['Smith/Finished', 'Smith/Before']) expect(found[folder]).toMatchObject({ job_id: project, tags: [stored] });
      for (const folder of ['Smithson', 'Smith, Jones (shared)']) expect(found[folder]).toMatchObject({ job_id: null, tags: [] });
      // A folder name full of filter punctuation is just a name.
      expect((await (await edit(picked.id, { folder: 'Smith, Jones (shared)', album_name: '' })).json())).toEqual({ updated: 1, settled: { album_name: 'Smith, Jones (shared)', album_id: null, albums: null } });
    });
    it('pages folder rows, and hides a folder that no longer holds photos', async () => {
      const id = await batch(); const sourceId = randomUUID();
      await read(id, Array.from({ length: 7 }, (_, n) => `Folder ${n}/a.jpg`), { id: sourceId });
      const first = await ok(folders, id, undefined, { query: '?limit=3' });
      expect(first.folders).toHaveLength(3); expect(first.next_cursor).toEqual(expect.any(String));
      const second = await ok(folders, id, undefined, { query: `?limit=3&after=${first.next_cursor}` });
      expect(second.folders.some((row: Row) => first.folders.some((seen: Row) => seen.id === row.id))).toBe(false);
      // The list ends with an EMPTY page, not a short one: a reader must never mistake a capped page for the end.
      const third = await ok(folders, id, undefined, { query: `?limit=3&after=${second.next_cursor}` });
      expect(third.folders).toHaveLength(1); expect(third.next_cursor).toEqual(expect.any(String));
      expect(await ok(folders, id, undefined, { query: `?limit=3&after=${third.next_cursor}` })).toEqual({ folders: [], next_cursor: null });
      expect((await invoke(folders, id, undefined, { query: '?limit=501' })).status).toBe(400);
      await read(id, ['Folder 0/a.jpg'], { id: sourceId });
      expect(Object.keys(await rows(id))).toEqual(['Folder 0']);
    });
  });

  describe('boundaries of the new routes', () => {
    it('signed out is 401; someone else’s import is 403 to edit; a bad body is 400; after Start it is 409', async () => {
      const id = await batch(); const picked = await read(id, ['Smith/a.jpg']);
      const body = { folder: 'Smith', tags: ['x'] };
      expect((await invoke(folders, id, undefined, { actor: null })).status).toBe(401);
      expect((await edit(picked.id, body, { actor: null })).status).toBe(401);
      expect((await edit(picked.id, body, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await edit(picked.id, body, { actor: f.employeeB })).status).toBe(403);
      // Any signed-in employee may LOOK at an import; only its creator changes it.
      expect((await invoke(folders, id, undefined, { actor: f.employeeB })).status).toBe(200);
      for (const bad of [{}, { folder: 'Smith' }, { tags: ['x'] }, { folder: '../up', tags: ['x'] }, { folder: '/abs', tags: ['x'] }, { folder: 'Smith', tags: 'x' },
        { folder: 'Smith', job_id: 'not-a-uuid' }, { folder: 'Smith', sheet_number: 'S-1', tags: ['x'] }, { folder: 'Smith', include_subfolders: 'yes', tags: ['x'] },
        { folder: 'Smith', include_subfolders: true, album_name: 'One name for all' }, { folder: 'Smith', album_id: randomUUID() }]) {
        expect((await edit(picked.id, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await edit(picked.id, { folder: 'Nowhere', tags: ['x'] })).status).toBe(404);
      expect((await approve(id)).status).toBe(200);
      expect((await edit(picked.id, body)).status).toBe(409);
    });
    it('the writes gate closes both routes with 503', async () => {
      const id = await batch(); const picked = await read(id, ['Smith/a.jpg']);
      try {
        await f.sql.query('update public.photo_release_state set photo_writes_enabled=false');
        expect((await invoke(folders, id)).status).toBe(503);
        expect((await edit(picked.id, { folder: 'Smith', tags: ['x'] })).status).toBe(503);
      } finally { await f.sql.query('update public.photo_release_state set photo_writes_enabled=true'); }
    });
    it('lists earlier imports with their folders’ names, and finds a project by name as well as number', async () => {
      const id = await batch(); await read(id, ['a.jpg'], { label: `First ${tag}` }); await read(id, ['b.jpg'], { label: `Second ${tag}` });
      const listed = (await ok(recent, '')).batches.find((row: { id: string }) => row.id === id);
      expect(listed.labels).toEqual([`First ${tag}`, `Second ${tag}`]);
      expect(listed).not.toHaveProperty('migration_sources');
      const byName = await ok(jobs, '', undefined, { query: `?q=${encodeURIComponent(`harbour house ${tag}`)}` });
      expect(byName.jobs.map((job: { job_number: string }) => job.job_number)).toEqual([number]);
      const byNumber = await ok(jobs, '', undefined, { query: `?q=${number}` });
      expect(byNumber.jobs.map((job: { job_number: string }) => job.job_number)).toContain(number);
    });
  });
});
