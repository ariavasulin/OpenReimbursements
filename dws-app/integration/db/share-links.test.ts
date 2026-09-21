import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// plans/active/photo-albums/plan.md, Phase 7 (AC-21, AC-22) at the database. This is the only
// surface reachable without a login, so the cases are adversarial: each one tries to read
// something the security contract in 20260921040000_photo_share_links.sql says cannot be read.
type Shared = { kind: string; name: string; count: number; photos: Array<Record<string, unknown>>; next_after: unknown } | null;

describe('share links (photo-albums AC-21, AC-22)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const tag = randomUUID().slice(0, 8);
  const UPLOADER_NAME = `Priya Uploader-${tag}`, SECRET_TAG = `secret-tag-${tag}`;
  let job: string, otherJob: string;
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true');
    await f.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', [UPLOADER_NAME, f.employeeB.id]);
    for (const [key, number] of [['job', `share-${tag}`], ['other', `share-other-${tag}`]] as const) {
      const made = await f.admin.from('jobs').insert({ job_number: number, name: `Shared project ${key} ${tag}`, is_active: true }).select('id').single();
      expect(made.error).toBeNull(); if (key === 'job') job = made.data!.id; else otherJob = made.data!.id;
    }
  });
  beforeEach(async () => { await f.sql.query('update public.photo_release_state set sharing_enabled=true'); });
  afterAll(async () => { await f.sql.query('update public.photo_release_state set sharing_enabled=false'); await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, args);
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) => (await f.admin.rpc(name, args)).error?.message;
  const album = async (name: string) => (await rpc('photo_create_album', { p_actor: f.employeeA.id, p_name: name })).album.id as string;
  let clock = Date.UTC(2026, 0, 1);
  /** A photo written directly, as the other suites do. Every one carries an uploader with a name, a tag, and an XMP sidecar. */
  async function photo(options: { jobId?: string | null; albums?: string[]; trashed?: boolean; kind?: string; name?: string } = {}) {
    const id = randomUUID(); clock += 60_000; const at = new Date(clock).toISOString();
    const inserted = await f.admin.from('photos').insert({ id, job_id: options.jobId ?? null, uploader_id: f.employeeB.id, kind: options.kind ?? 'image', captured_at: at,
      tags: [SECRET_TAG], original_name: options.name ?? `IMG_${id.slice(0, 6)}.jpg`, mime_type: 'image/jpeg',
      original_path: `originals/${f.employeeB.id}/${id}/${options.name ?? 'photo.jpg'}`, thumb_path: `derived/${f.employeeB.id}/${id}_thumb.webp`, preview_path: `derived/${f.employeeB.id}/${id}_preview.webp`,
      sidecar_path: `originals/${f.employeeB.id}/${id}/photo.xmp`, sidecar_name: 'photo.xmp',
      ...(options.trashed ? { deleted_at: at, deleted_by: f.employeeB.id, purge_after: new Date(clock + 30 * 86_400_000).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    for (const albumId of options.albums ?? []) expect((await f.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [albumId, id, f.employeeA.id])).rowCount).toBe(1);
    return id;
  }
  const share = async (target: { album?: string; job?: string }, enabled = true, actor = f.employeeA.id) =>
    rpc('photo_share_set', { p_actor: actor, p_album: target.album ?? null, p_job: target.job ?? null, p_enabled: enabled }) as Promise<{ enabled: boolean; token: string | null }>;
  const read = (token: string | null, after: unknown = null, limit = 100) => rpc('photo_share_read', { p_token: token, p_after: after, p_limit: limit }) as Promise<Shared>;
  const ids = (shared: Shared) => shared!.photos.map(row => row.id as string);

  describe('the switch', () => {
    it('is off for everyone by default, and the gate function accepts "sharing" without loosening anything else', async () => {
      expect((await f.sql.query("select column_default,is_nullable from information_schema.columns where table_name='photo_release_state' and column_name='sharing_enabled'")).rows)
        .toEqual([{ column_default: 'false', is_nullable: 'NO' }]);
      await f.sql.query('update public.photo_release_state set sharing_enabled=false');
      await expect(f.sql.query("select public.photo_require_gate('sharing')")).rejects.toThrow(/photo_gate_closed/);
      await f.sql.query('update public.photo_release_state set sharing_enabled=true');
      await expect(f.sql.query("select public.photo_require_gate('sharing')")).resolves.toBeDefined();
      await expect(f.sql.query("select public.photo_require_gate('writes')")).resolves.toBeDefined();
      for (const gate of ['Sharing', 'share', '', 'anything']) await expect(f.sql.query('select public.photo_require_gate($1)', [gate]), gate).rejects.toThrow(/photo_gate_closed/);
    });
    it('turning a link on gives a 32-byte base64url token; on again is the same link; off then on is a NEW one and the old stays dead', async () => {
      const a = await album(`Switch ${tag}`); const inside = await photo({ albums: [a] });
      const first = await share({ album: a });
      expect(first.enabled).toBe(true); expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(first.token!, 'base64url')).toHaveLength(32);
      expect((await share({ album: a })).token).toBe(first.token);
      expect(await rpc('photo_share_status', { p_actor: f.employeeB.id, p_album: a, p_job: null })).toMatchObject({ enabled: true, token: first.token, pages_open: true });
      expect(ids(await read(first.token))).toEqual([inside]);
      // Off: at once. Anyone may turn it off, and it records who.
      expect(await share({ album: a }, false, f.employeeB.id)).toEqual({ enabled: false, token: null, created_at: null });
      expect(await read(first.token)).toBeNull();
      expect((await f.sql.query('select revoked_by from public.photo_share_links where token=$1', [first.token])).rows).toEqual([{ revoked_by: f.employeeB.id }]);
      expect(await share({ album: a }, false)).toMatchObject({ enabled: false }); // off when already off
      // On again: a new address. The old one never comes back.
      const second = await share({ album: a });
      expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(second.token).not.toBe(first.token);
      expect(ids(await read(second.token))).toEqual([inside]); expect(await read(first.token)).toBeNull();
    });
    it('two people pressing "on" together get one link, and the table refuses a second live link outright', async () => {
      const a = await album(`Race ${tag}`);
      const tokens = await Promise.all(Array.from({ length: 6 }, (_, n) => share({ album: a }, true, n % 2 ? f.employeeA.id : f.employeeB.id)));
      expect(new Set(tokens.map(result => result.token)).size).toBe(1);
      expect((await f.sql.query('select count(*)::int as n from public.photo_share_links where album_id=$1', [a])).rows[0].n).toBe(1);
      await expect(f.sql.query('insert into public.photo_share_links(token,album_id,created_by) values($1,$2,$3)', ['x'.repeat(43), a, f.employeeA.id])).rejects.toThrow(/photo_share_links_live_album/);
      await expect(f.sql.query('insert into public.photo_share_links(token,album_id,job_id,created_by) values($1,$2,$3,$4)', ['y'.repeat(43), await album('Both'), job, f.employeeA.id])).rejects.toThrow(/check/);
      await expect(f.sql.query('insert into public.photo_share_links(token,created_by) values($1,$2)', ['z'.repeat(43), f.employeeA.id])).rejects.toThrow(/check/);
    });
    it('refuses a target that is not live, both or neither target, and a caller who is not an employee', async () => {
      const gone = await album(`Gone ${tag}`); await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: gone });
      const closed = (await f.admin.from('jobs').insert({ job_number: `closed-${tag}`, name: 'Closed', is_active: false }).select('id').single()).data!.id;
      expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: gone, p_job: null, p_enabled: true })).toBe('not_found');
      expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: null, p_job: closed, p_enabled: true })).toBe('not_found');
      expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: randomUUID(), p_job: null, p_enabled: true })).toBe('not_found');
      expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: await album('x'), p_job: job, p_enabled: true })).toBe('invalid_input');
      expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: null, p_job: null, p_enabled: true })).toBe('invalid_input');
      expect(await refused('photo_share_set', { p_actor: randomUUID(), p_album: null, p_job: job, p_enabled: true })).toBe('invalid_actor');
      await f.sql.query('update public.photo_release_state set photo_writes_enabled=false');
      try { expect(await refused('photo_share_set', { p_actor: f.employeeA.id, p_album: null, p_job: job, p_enabled: true })).toBe('photo_gate_closed'); }
      finally { await f.sql.query('update public.photo_release_state set photo_writes_enabled=true'); }
    });
  });

  describe('what a token can read', () => {
    it('[3] album A’s token never lists a photo that is only in album B, in no album, or in A but trashed', async () => {
      const a = await album(`Album A ${tag}`), b = await album(`Album B ${tag}`);
      const inA = await photo({ albums: [a], jobId: job }), inBoth = await photo({ albums: [a, b] });
      const onlyB = await photo({ albums: [b], jobId: job }), nowhere = await photo({ jobId: job }), trashedInA = await photo({ albums: [a], trashed: true });
      const token = (await share({ album: a })).token;
      const shared = await read(token);
      expect(shared).toMatchObject({ kind: 'album', name: `Album A ${tag}`, count: 2 });
      expect(ids(shared).sort()).toEqual([inA, inBoth].sort());
      for (const forbidden of [onlyB, nowhere, trashedInA]) expect(ids(shared)).not.toContain(forbidden);
      // Restoring brings it back; trashing a listed one removes it; the count follows.
      await f.sql.query('update public.photos set deleted_at=null,deleted_by=null,purge_after=null where id=$1', [trashedInA]);
      expect((await read(token))!.count).toBe(3);
      await f.sql.query("update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval '30 days' where id=$1", [inA, f.employeeB.id]);
      const after = await read(token); expect(after!.count).toBe(2); expect(ids(after)).not.toContain(inA);
    });
    it('[3] a project’s token lists only that project’s active photos', async () => {
      const mine = await photo({ jobId: job }), theirs = await photo({ jobId: otherJob }), none = await photo({ jobId: null }), trashed = await photo({ jobId: job, trashed: true });
      const shared = await read((await share({ job })).token);
      expect(shared).toMatchObject({ kind: 'project', name: `Shared project job ${tag}` });
      expect(ids(shared)).toContain(mine);
      for (const forbidden of [theirs, none, trashed]) expect(ids(shared)).not.toContain(forbidden);
      // Moving a photo out of the project removes it from the project's page.
      await f.sql.query('update public.photos set job_id=$2 where id=$1', [mine, otherJob]);
      expect(ids(await read((await share({ job })).token))).not.toContain(mine);
    });
    it('[2] unknown, malformed, revoked, gate-closed, and deleted-album tokens are all the same answer: nothing', async () => {
      const a = await album(`Nothing ${tag}`); await photo({ albums: [a] });
      const live = (await share({ album: a })).token!;
      expect(await read(live)).not.toBeNull();
      const never = Buffer.from(randomUUID() + randomUUID()).subarray(0, 32).toString('base64url');
      for (const token of [never, '', 'short', `${live}x`, live.slice(0, 42), `${live.slice(0, 42)}=`, "' or 1=1 --", `${live}%`, null]) expect(await read(token), String(token)).toBeNull();
      // Gate closed: every link, at once. The function returns nothing; it does not raise.
      await f.sql.query('update public.photo_release_state set sharing_enabled=false');
      expect(await f.admin.rpc('photo_share_read', { p_token: live, p_after: null, p_limit: 100 })).toMatchObject({ data: null, error: null });
      await f.sql.query('update public.photo_release_state set sharing_enabled=true');
      expect(await read(live)).not.toBeNull();
      // A deleted album shares nothing, even though its link row is still "on"; restoring the album restores the page.
      await rpc('photo_delete_album', { p_actor: f.employeeA.id, p_album: a });
      expect(await read(live)).toBeNull();
      await rpc('photo_restore_album', { p_actor: f.employeeA.id, p_album: a });
      expect(await read(live)).not.toBeNull();
    });
    it('[4] the answer holds no uploader, tag, XMP, other album, or project number, and only images and videos', async () => {
      const a = await album(`Private ${tag}`), other = await album(`Other album ${tag}`);
      const image = await photo({ albums: [a, other], jobId: job, name: 'kitchen.jpg' }), video = await photo({ albums: [a], kind: 'video', name: 'walkthrough.mp4' });
      const strayXmp = await photo({ albums: [a], kind: 'file', name: 'kitchen.xmp' });
      const shared = await read((await share({ album: a })).token);
      expect(Object.keys(shared!).sort()).toEqual(['count', 'kind', 'name', 'next_after', 'photos']);
      expect(ids(shared).sort()).toEqual([image, video].sort()); expect(shared!.count).toBe(2);
      expect(ids(shared)).not.toContain(strayXmp);
      for (const row of shared!.photos) expect(Object.keys(row).sort()).toEqual(
        ['captured_at', 'duration_secs', 'id', 'kind', 'mime_type', 'original_name', 'original_path', 'playback_path', 'preview_path', 'thumb_path']);
      const text = JSON.stringify(shared);
      for (const secret of [UPLOADER_NAME, 'Priya', SECRET_TAG, '.xmp', 'sidecar', `Other album ${tag}`, `share-${tag}`, 'uploader', 'tags', 'job_id', 'token', 'created_by']) {
        expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
      }
    });
    it('[1] takes its target from the token alone: the function has no album, project, or photo parameter', async () => {
      const args = (await f.sql.query("select pg_get_function_identity_arguments(oid) as args from pg_proc where proname='photo_share_read' and pronamespace='public'::regnamespace")).rows;
      expect(args).toEqual([{ args: 'p_token text, p_after jsonb, p_limit integer' }]);
    });
    it('pages newest first without repeats, and a cursor it did not make reads as nothing', async () => {
      const a = await album(`Paged ${tag}`); const made: string[] = [];
      for (let n = 0; n < 5; n++) made.push(await photo({ albums: [a] }));
      const token = (await share({ album: a })).token;
      const seen: string[] = []; let after: unknown = null; let pages = 0;
      do { const page = await read(token, after, 2); seen.push(...ids(page)); after = page!.next_after; expect(page!.count).toBe(5); pages++; } while (after && pages < 10);
      expect(seen).toEqual([...made].reverse());
      expect((await read(token, null, 9999))!.photos).toHaveLength(5); // an out-of-range size reads as the default, not as "everything"
      for (const bad of [{ id: 'nope', captured_at: 'never' }, { id: made[0] }, { captured_at: '2026-01-01T00:00:00Z' }, {}, [], 'text', 7, true]) expect(await read(token, bad), JSON.stringify(bad)).toBeNull();
    });
  });

  describe('[5] who may touch any of it', () => {
    it('no browser role can read the token table or call any share function; the service role can', async () => {
      const a = await album(`Locked ${tag}`); const token = (await share({ album: a })).token!;
      for (const client of [f.employeeA.client, f.administrator.client, f.anon]) {
        const rows = await client.from('photo_share_links').select('token');
        expect(rows.data ?? []).toEqual([]);
        expect((await client.rpc('photo_share_read', { p_token: token, p_after: null, p_limit: 10 })).error).not.toBeNull();
        expect((await client.rpc('photo_share_set', { p_actor: f.employeeA.id, p_album: a, p_job: null, p_enabled: false })).error).not.toBeNull();
        expect((await client.rpc('photo_share_status', { p_actor: f.employeeA.id, p_album: a, p_job: null })).error).not.toBeNull();
        expect((await client.from('photo_release_state').update({ sharing_enabled: true }).eq('singleton', true).select()).data ?? []).toEqual([]);
      }
      const grants = (await f.sql.query(`select grantee,privilege_type from information_schema.role_table_grants where table_name='photo_share_links' and grantee in ('anon','authenticated','PUBLIC')`)).rows;
      expect(grants).toEqual([]);
      for (const name of ['photo_share_read', 'photo_share_set', 'photo_share_status']) {
        const acl = (await f.sql.query(`select has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as authenticated,
          has_function_privilege('service_role',oid,'execute') as service from pg_proc where proname=$1 and pronamespace='public'::regnamespace`, [name])).rows;
        expect(acl, name).toEqual([{ anon: false, authenticated: false, service: true }]);
      }
      expect(await read(token)).not.toBeNull(); // still on: the refused calls above changed nothing
    });
  });
});
