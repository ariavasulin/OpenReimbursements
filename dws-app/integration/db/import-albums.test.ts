import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// plans/active/photo-albums/plan.md, Phase 6: AC-16, AC-17, AC-18 and the import half of AC-7,
// at the database. Every scenario owns its rows and removes any large fixture it makes.
type Entry = { relative_path: string; original_name: string; original_bytes: number; source_mtime: number;
  source_signature: string; mime_type: string; status: string; warnings: string[]; sidecar: null };
type Item = Entry & { id: string; source_id: string; revision: number; photo_id: string; original_path: string | null; is_current: boolean };
type Folder = { id: string; folder: string; album_name: string | null; album_id: string | null; job_id: string | null; tags: string[]; photo_count: number };

describe('folders import as albums (photo-albums AC-16, AC-17, AC-18, AC-7)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  let jobA: string, jobB: string;
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true, mcp_enabled: true }).eq('singleton', true)).error).toBeNull();
    await f.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
    const made: string[] = [];
    for (const number of ['import-3612', 'import-4170']) {
      const { data, error } = await f.admin.from('jobs').upsert({ job_number: number, name: `Import ${number}`, is_active: true }, { onConflict: 'job_number' }).select('id').single();
      expect(error).toBeNull(); made.push(data!.id);
    }
    [jobA, jobB] = made;
  });
  afterAll(async () => { await f?.close(); });

  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await f.admin.rpc(name, { p_actor: f.employeeA.id, ...args });
    expect(error, `${name}: ${error?.message}`).toBeNull();
    return data;
  }
  const refused = async (name: string, args: Record<string, unknown>) =>
    (await f.admin.rpc(name, { p_actor: f.employeeA.id, ...args })).error?.message;
  const entry = (path: string, status = 'pending', mtime = 1): Entry => ({ relative_path: path, original_name: path.split('/').at(-1)!,
    original_bytes: 8, source_mtime: mtime, source_signature: `${path}:8:${mtime}`, mime_type: 'image/jpeg', status, warnings: [], sidecar: null });
  const action = (batch: string, p_action: string) => rpc('migration_batch_action', { p_batch: batch, p_action });
  const owner = (item: { id: string }) => ({ p_owner_kind: 'migration', p_owner_id: item.id });
  const batch = async (script = 'migrate_photos') => (await rpc('migration_create_batch', { p_script: script })).id as string;
  const source = (batchId: string, options: { job?: string | null; kind?: string; label?: string; rules?: object } = {}) =>
    rpc('migration_source', { p_batch: batchId, p_source: randomUUID(), p_job: options.job ?? null, p_kind: options.kind ?? 'directory',
      p_label: options.label ?? 'Office drive', p_rules: options.rules ?? {} });
  async function seal(sourceId: string, entries: Entry[]) {
    const scanId = randomUUID(); await rpc('migration_scan', { p_source: sourceId, p_scan: scanId });
    const payload = JSON.stringify(entries); const digest = createHash('sha256').update(payload).digest('hex');
    await rpc('migration_chunk', { p_source: sourceId, p_scan: scanId, p_number: 0, p_entries: entries, p_digest: digest, p_encoded: Buffer.byteLength(payload) });
    const job = (await f.admin.from('migration_sources').select('job_id').eq('id', sourceId).single()).data!.job_id;
    await rpc('migration_seal', { p_source: sourceId, p_scan: scanId, p_chunks: 1, p_job: job, p_entries: entries.length,
      p_bytes: entries.reduce((n, e) => n + e.original_bytes, 0), p_fingerprint: createHash('sha256').update(digest).digest('hex') });
    return scanId;
  }
  async function folders(sourceId: string): Promise<Folder[]> {
    const { data, error } = await f.admin.from('migration_folders').select('id,folder,album_name,album_id,job_id,tags,photo_count').eq('source_id', sourceId).order('folder');
    expect(error).toBeNull(); return data as Folder[];
  }
  async function items(sourceId: string): Promise<Item[]> {
    const { data, error } = await f.admin.from('migration_items').select('*').eq('source_id', sourceId).eq('is_current', true).order('relative_path');
    expect(error).toBeNull(); return data as Item[];
  }
  const patch = (sourceId: string, folder: string, p_patch: object, subfolders = false) =>
    ({ p_source: sourceId, p_folder: folder, p_subfolders: subfolders, p_patch });
  /** Hash, lease, and claim one item. Returns the claim outcome; `claimed` means bytes must upload. */
  async function claim(item: Item, bytes: Uint8Array = randomBytes(8)) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const ready = await rpc('migration_prepare', { p_item: item.id, p_revision: item.revision, p_signature: item.source_signature, p_digest: digest }) as Item & { result: { status: string } | null };
    if (ready.result) return { ready, bytes, digest, lease: null, claimed: ready.result };
    const lease = await rpc('photo_acquire_upload', owner(item));
    const claimed = await rpc('photo_claim_content', { ...owner(item), p_generation: lease.lease_generation });
    return { ready, bytes, digest, lease, claimed };
  }
  async function commit(item: Item, photo: object = { kind: 'image' }, bytes?: Uint8Array) {
    const c = await claim(item, bytes);
    expect(c.claimed.status).toBe('claimed');
    expect((await f.employeeA.client.storage.from('photos').upload(c.ready.original_path!, c.bytes, { contentType: 'image/jpeg' })).error).toBeNull();
    const result = await rpc('photo_finalize_upload', { ...owner(item), p_generation: c.lease!.lease_generation, p_claim_generation: c.claimed.claim_generation, p_photo: photo });
    expect(result.status).toBe('created');
    return { ...c, result };
  }
  /** An active (or trashed) photo written directly, as the existing suites do. */
  async function existingPhoto(options: { bytes: Uint8Array; jobId: string | null; trashed?: boolean; tags?: string[] }) {
    const id = randomUUID(); const now = Date.now();
    const inserted = await f.admin.from('photos').insert({ id, job_id: options.jobId, uploader_id: f.employeeB.id, kind: 'image',
      captured_at: new Date(now).toISOString(), tags: options.tags ?? [], original_path: `originals/${f.employeeB.id}/${id}/fixture.jpg`,
      content_sha256: createHash('sha256').update(options.bytes).digest('hex'),
      ...(options.trashed ? { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeB.id, purge_after: new Date(now + 30 * 86_400_000).toISOString() } : {}) });
    expect(inserted.error).toBeNull();
    return id;
  }
  const albumsNamed = async (name: string) => (await f.sql.query('select id from public.albums where name=$1', [name])).rows.map(row => row.id as string);
  const membersOf = async (albumId: string) => (await f.sql.query('select photo_id from public.album_photos where album_id=$1 order by photo_id', [albumId])).rows.map(row => row.photo_id as string);
  const photoRow = async (id: string) => (await f.sql.query('select job_id,tags from public.photos where id=$1', [id])).rows[0] as { job_id: string | null; tags: string[] } | undefined;

  describe('AC-16: a folder tree imports with no edits, one album per folder', () => {
    it('derives one row per folder that directly holds an importable photo, named from its path', async () => {
      const id = await batch(); const s = await source(id, { label: 'Office  drive ' });
      await seal(s.id, [entry('site.jpg'), entry('Smith Residence/Finished/a.jpg'), entry('Smith Residence/Finished/b.jpg'),
        entry('Smith Residence/Before/c.jpg'), entry('Smith Residence/Before/Demo/d.jpg'),
        entry('Excluded/.picasa.ini', 'skipped_unsupported'), entry('Excluded/Thumbs.db', 'skipped_unsupported')]);
      expect(await folders(s.id)).toEqual([
        expect.objectContaining({ folder: '', album_name: 'Office drive', photo_count: 1, album_id: null, job_id: null, tags: [] }),
        expect.objectContaining({ folder: 'Smith Residence/Before', album_name: 'Smith Residence – Before', photo_count: 1 }),
        expect.objectContaining({ folder: 'Smith Residence/Before/Demo', album_name: 'Smith Residence – Before – Demo', photo_count: 1 }),
        expect.objectContaining({ folder: 'Smith Residence/Finished', album_name: 'Smith Residence – Finished', photo_count: 2 }),
      ]);
      // "Smith Residence" holds no photo directly and "Excluded" holds nothing importable: no rows, so no albums.
    });

    it('keeps the end of a path too long for an album name', async () => {
      const deep = Array.from({ length: 12 }, (_, n) => `Level ${n} of a deep folder tree`).join('/');
      const name = (await f.sql.query('select public.migration_album_name($1,$2) as name', ['Picked', deep])).rows[0].name as string;
      expect(name.length).toBeLessThanOrEqual(120);
      expect(name.startsWith('… – ')).toBe(true);
      expect(name.endsWith('Level 11 of a deep folder tree')).toBe(true);
      const one = (await f.sql.query('select public.migration_album_name($1,$2) as name', ['Picked', 'x'.repeat(300)])).rows[0].name as string;
      expect(one).toHaveLength(120); expect(one.endsWith('…')).toBe(true);
    });

    it('pressing Start with no edits imports every photo into its folder’s album, with no project', async () => {
      const id = await batch(); const s = await source(id);
      await seal(s.id, [entry('Tree/One/a.jpg'), entry('Tree/One/b.jpg'), entry('Tree/Two/Deep/c.jpg')]);
      // Nothing exists before the employee confirms, and nothing until a photo really lands.
      expect((await folders(s.id)).every(row => row.album_id === null)).toBe(true);
      await action(id, 'approve'); await action(id, 'resume');
      expect((await folders(s.id)).every(row => row.album_id === null)).toBe(true);
      const committed = [];
      for (const item of await items(s.id)) committed.push({ item, ...(await commit(item)) });
      const rows = await folders(s.id);
      expect(rows.map(row => row.album_name)).toEqual(['Tree – One', 'Tree – Two – Deep']);
      for (const row of rows) {
        expect(row.album_id).not.toBeNull();
        const inFolder = committed.filter(c => c.item.relative_path.startsWith(`${row.folder}/`)).map(c => c.item.photo_id).sort();
        expect(await membersOf(row.album_id!)).toEqual(inFolder);
        expect((await f.sql.query('select name,created_by,deleted_at from public.albums where id=$1', [row.album_id])).rows[0])
          .toEqual({ name: row.album_name, created_by: f.employeeA.id, deleted_at: null });
      }
      for (const c of committed) expect((await photoRow(c.item.photo_id))!.job_id).toBeNull();
      expect((await action(id, 'complete')).status).toBe('completed');
    });

    it('pause and resume, a rescan, and a retry never make a second album for the same folder', async () => {
      const label = `Once ${randomUUID()}`; const id = await batch(); const s = await source(id, { label });
      await seal(s.id, [entry('a.jpg'), entry('b.jpg'), entry('c.jpg')]);
      await action(id, 'approve'); await action(id, 'resume');
      const [a, b, c] = await items(s.id);
      await commit(a);
      const album = (await folders(s.id))[0].album_id!;
      await action(id, 'pause'); await action(id, 'resume');
      await commit(b);
      // A rescan that also finds a new file in the same folder.
      await seal(s.id, [entry('a.jpg'), entry('b.jpg'), entry('c.jpg'), entry('d.jpg')]);
      expect((await folders(s.id))[0]).toMatchObject({ album_id: album, photo_count: 4, album_name: label });
      await action(id, 'resume');
      // A retry that needs a fresh attempt, then succeeds.
      const fresh = await rpc('migration_item_action', { p_item: c.id, p_action: 'retry', p_fresh: true }) as Item;
      await commit(fresh);
      await commit((await items(s.id)).find(item => item.relative_path === 'd.jpg')!);
      expect(await albumsNamed(label)).toEqual([album]);
      expect(await membersOf(album)).toHaveLength(4);
      expect((await folders(s.id))[0].album_id).toBe(album);
    });

    it('leaves no album for a folder whose photos are all skipped, all failed, or all sitting in trash', async () => {
      const tag = randomUUID(); const id = await batch(); const s = await source(id, { label: `Root ${tag}` });
      const trashedBytes = randomBytes(8);
      await existingPhoto({ bytes: trashedBytes, jobId: jobA, trashed: true });
      await seal(s.id, [entry(`Skipped ${tag}/s.jpg`), entry(`Failed ${tag}/f.jpg`), entry(`Trashed ${tag}/t.jpg`), entry(`Kept ${tag}/k.jpg`)]);
      await action(id, 'approve'); await action(id, 'resume');
      const all = await items(s.id); const find = (prefix: string) => all.find(item => item.relative_path.startsWith(prefix))!;
      await rpc('migration_item_action', { p_item: find('Skipped').id, p_action: 'skip' });
      // Failed: hashed and claimed, but the bytes never arrive, so it is released as a failure.
      const failed = await claim(find('Failed'));
      await rpc('photo_release_upload', { ...owner(find('Failed')), p_generation: failed.lease!.lease_generation, p_status: 'retryable_failed', p_error_code: 'storage_upload_failed' });
      // Trashed: the bytes exist only as a photo in trash. It is left alone and joins nothing.
      expect((await claim(find('Trashed'), trashedBytes)).claimed.status).toBe('duplicate_trashed');
      await commit(find('Kept'));
      const rows = await folders(s.id);
      expect(rows.filter(row => row.album_id !== null).map(row => row.folder)).toEqual([`Kept ${tag}`]);
      for (const name of [`Skipped ${tag}`, `Failed ${tag}`, `Trashed ${tag}`]) expect(await albumsNamed(name)).toEqual([]);
      expect(await albumsNamed(`Kept ${tag}`)).toHaveLength(1);
    });
  });

  describe('AC-7, import half: a folder of copies becomes an album of the existing photos', () => {
    it('adds the existing photos to the folder’s album and makes no new photo rows', async () => {
      const tag = randomUUID(); const copies = [randomBytes(8), randomBytes(8)];
      const originals = [await existingPhoto({ bytes: copies[0], jobId: jobA }), await existingPhoto({ bytes: copies[1], jobId: jobB })];
      const before = (await f.sql.query('select count(*)::int as n from public.photos')).rows[0].n as number;
      const id = await batch(); const s = await source(id);
      await seal(s.id, [entry(`Marketing ${tag}/one.jpg`), entry(`Marketing ${tag}/two.jpg`)]);
      await action(id, 'approve'); await action(id, 'resume');
      const [one, two] = await items(s.id);
      // Caught at claim, before any bytes move. The folder names no project, so nothing can conflict.
      expect((await claim(one, copies[0])).claimed).toMatchObject({ status: 'duplicate_active', photo_id: originals[0] });
      expect((await claim(two, copies[1])).claimed).toMatchObject({ status: 'duplicate_active', photo_id: originals[1] });
      expect((await items(s.id)).map(item => item.status)).toEqual(['skipped_duplicate', 'skipped_duplicate']);
      const [album] = await albumsNamed(`Marketing ${tag}`);
      expect(await membersOf(album)).toEqual([...originals].sort());
      expect((await f.sql.query('select count(*)::int as n from public.photos')).rows[0].n).toBe(before);
      // Each keeps the project it already had.
      expect((await photoRow(originals[0]))!.job_id).toBe(jobA); expect((await photoRow(originals[1]))!.job_id).toBe(jobB);
      expect((await action(id, 'complete')).status).toBe('completed');
    });

    it('a folder given a different project still adds the photo to its album, and reports the conflict', async () => {
      const tag = randomUUID(); const bytes = randomBytes(8); const original = await existingPhoto({ bytes, jobId: jobA, tags: ['kept'] });
      const id = await batch(); const s = await source(id);
      await seal(s.id, [entry(`Clash ${tag}/x.jpg`)]);
      await rpc('migration_folder_update', patch(s.id, `Clash ${tag}`, { job_id: jobB, tags: ['imported'] }));
      await action(id, 'approve'); await action(id, 'resume');
      expect((await claim((await items(s.id))[0], bytes)).claimed).toMatchObject({ status: 'duplicate_active', job_id: jobA });
      expect((await items(s.id))[0].status).toBe('job_conflict');
      expect(await membersOf((await albumsNamed(`Clash ${tag}`))[0])).toEqual([original]);
      // The existing project is kept, and an existing photo is not retagged by an import.
      expect(await photoRow(original)).toEqual({ job_id: jobA, tags: ['kept'] });
    });

    it('fills an empty project on the existing photo from the folder’s project', async () => {
      const tag = randomUUID(); const bytes = randomBytes(8); const original = await existingPhoto({ bytes, jobId: null });
      const id = await batch(); const s = await source(id, { job: jobA });
      await seal(s.id, [entry(`Fill ${tag}/x.jpg`)]);
      await action(id, 'approve'); await action(id, 'resume');
      await claim((await items(s.id))[0], bytes);
      expect((await photoRow(original))!.job_id).toBe(jobA);
      expect((await items(s.id))[0].status).toBe('skipped_duplicate');
    });
  });

  describe('AC-17: the folder row is the unit of import choices', () => {
    it('a new row starts from the source’s default project and tags', async () => {
      const id = await batch(); const s = await source(id, { job: jobA, rules: { tags: ['  field dimension ', 'Field Dimension', 'shop drawing'] } });
      await seal(s.id, [entry('x/a.jpg'), entry('y/b.jpg')]);
      for (const row of await folders(s.id)) expect(row).toMatchObject({ job_id: jobA, tags: ['field dimension', 'shop drawing'] });
      // A rules object that is not a clean tag list reads as "no tags" rather than failing the seal.
      const other = await batch(); const junk = await source(other, { rules: { tags: 'not-a-list' } });
      await seal(junk.id, [entry('a.jpg')]);
      expect((await folders(junk.id))[0].tags).toEqual([]);
    });

    it('a choice on a top-level folder applies to the folders inside it, even when it holds no photos itself', async () => {
      const id = await batch(); const s = await source(id);
      await seal(s.id, [entry('root.jpg'), entry('Smith/Finished/a.jpg'), entry('Smith/Before/b.jpg'), entry('Smith/Before/Demo/c.jpg'), entry('Smithson/d.jpg')]);
      expect(await rpc('migration_folder_update', patch(s.id, 'Smith', { job_id: jobA, tags: ['professional'] }, true))).toEqual({ updated: 3 });
      const rows = Object.fromEntries((await folders(s.id)).map(row => [row.folder, row]));
      for (const folder of ['Smith/Finished', 'Smith/Before', 'Smith/Before/Demo']) expect(rows[folder]).toMatchObject({ job_id: jobA, tags: ['professional'] });
      // "Smithson" merely starts with the same letters; the picked folder itself is outside "Smith".
      for (const folder of ['', 'Smithson']) expect(rows[folder]).toMatchObject({ job_id: null, tags: [] });
      // The picked folder reaches every row. One row can then differ again.
      expect(await rpc('migration_folder_update', patch(s.id, '', { tags: ['office'] }, true))).toEqual({ updated: 5 });
      expect(await rpc('migration_folder_update', patch(s.id, 'Smith/Before', { job_id: null }))).toEqual({ updated: 1 });
      const after = Object.fromEntries((await folders(s.id)).map(row => [row.folder, row]));
      expect(after['Smith/Before']).toMatchObject({ job_id: null, tags: ['office'] });
      expect(after['Smith/Finished']).toMatchObject({ job_id: jobA, tags: ['office'] });
    });

    it('renames one album, restores the default from a blank name, and never spreads a name', async () => {
      const id = await batch(); const s = await source(id);
      await seal(s.id, [entry('Smith/Finished/a.jpg'), entry('Smith/Before/b.jpg')]);
      await rpc('migration_folder_update', patch(s.id, 'Smith/Finished', { album_name: '  Smith   kitchen, done ' }));
      expect((await folders(s.id)).find(row => row.folder === 'Smith/Finished')!.album_name).toBe('Smith kitchen, done');
      await rpc('migration_folder_update', patch(s.id, 'Smith/Finished', { album_name: '   ' }));
      expect((await folders(s.id)).find(row => row.folder === 'Smith/Finished')!.album_name).toBe('Smith – Finished');
      expect(await refused('migration_folder_update', patch(s.id, 'Smith', { album_name: 'All one name' }, true))).toBe('invalid_input');
      expect(await refused('migration_folder_update', patch(s.id, 'Smith/Finished', { album_name: 'x'.repeat(121) }))).toBe('invalid_input');
      // A folder always becomes its own album (Decision 9): it cannot be pointed at an existing one.
      const existing = (await rpc('photo_create_album', { p_name: 'Existing album' })).album.id;
      expect(await refused('migration_folder_update', patch(s.id, 'Smith/Finished', { album_id: existing }))).toBe('invalid_input');
    });

    it('refuses unknown keys, unusable projects, a folder with no row, and anyone but the batch’s creator', async () => {
      const id = await batch(); const s = await source(id); await seal(s.id, [entry('a/x.jpg')]);
      const inactive = randomUUID();
      expect((await f.admin.from('jobs').insert({ id: inactive, job_number: `inactive-${inactive}`, name: 'Closed', is_active: false })).error).toBeNull();
      for (const bad of [{}, { sheet_number: 'S-1' }, { job_id: inactive }, { job_id: randomUUID() }, { tags: 'one' }, { tags: Array.from({ length: 21 }, (_, n) => `t${n}`) }]) {
        expect(await refused('migration_folder_update', patch(s.id, 'a', bad)), JSON.stringify(bad)).toBe('invalid_input');
      }
      expect(await refused('migration_folder_update', patch(s.id, 'missing', { tags: ['x'] }))).toBe('not_found');
      expect((await f.admin.rpc('migration_folder_update', { p_actor: f.employeeB.id, ...patch(s.id, 'a', { tags: ['x'] }) })).error?.message).toBe('wrong_consumer');
      // Browser roles can neither call it nor read the rows.
      expect((await f.employeeA.client.rpc('migration_folder_update', { p_actor: f.employeeA.id, ...patch(s.id, 'a', { tags: ['x'] }) })).error).not.toBeNull();
      expect((await f.employeeA.client.from('migration_folders').select('id').eq('source_id', s.id)).data ?? []).toEqual([]);
    });

    it('a tag that matches a stored one ignoring case takes the stored spelling', async () => {
      const spelling = `kitchen-${randomUUID().slice(0, 8)}`;
      await existingPhoto({ bytes: randomBytes(8), jobId: jobA, tags: [spelling] });
      const id = await batch(); const s = await source(id); await seal(s.id, [entry('a/x.jpg')]);
      await rpc('migration_folder_update', patch(s.id, 'a', { tags: [spelling.toUpperCase(), 'Brand New'] }));
      expect((await folders(s.id))[0].tags).toEqual([spelling, 'Brand New']);
    });

    it('rows freeze on approve: no edit, no suggestion, and no other writer can change them', async () => {
      const id = await batch(); const s = await source(id); const scanId = await seal(s.id, [entry('a/x.jpg')]);
      await action(id, 'approve');
      expect(await refused('migration_folder_update', patch(s.id, 'a', { tags: ['late'] }))).toBe('conflict');
      expect(await refused('migration_folder_suggest', { p_source: s.id, p_scan: scanId, p_rows: [{ folder: 'a', job_id: jobA }] })).toBe('conflict');
      const [row] = await folders(s.id);
      for (const change of [{ tags: ['late'] }, { job_id: jobA }, { album_name: 'Renamed late' }]) {
        expect((await f.admin.from('migration_folders').update(change).eq('id', row.id)).error, JSON.stringify(change)).not.toBeNull();
      }
      // The album appears once, and from then on that is fixed too.
      await action(id, 'resume'); await commit((await items(s.id))[0]);
      const album = (await folders(s.id))[0].album_id!;
      expect((await f.admin.from('migration_folders').update({ album_id: (await rpc('photo_create_album', { p_name: 'Other' })).album.id }).eq('id', row.id)).error).not.toBeNull();
      expect((await folders(s.id))[0]).toMatchObject({ album_id: album, tags: [], job_id: null, album_name: 'a' });
    });

    it('a suggestion fills only a row this scan made that still has no project, and only with an active one', async () => {
      const id = await batch(); const s = await source(id);
      const first = await seal(s.id, [entry('3612 Smith/a.jpg'), entry('4170 Jones/b.jpg'), entry('Party/c.jpg')]);
      await rpc('migration_folder_update', patch(s.id, '4170 Jones', { job_id: jobB }));
      expect(await rpc('migration_folder_suggest', { p_source: s.id, p_scan: first, p_rows: [
        { folder: '3612 Smith', job_id: jobA }, { folder: '4170 Jones', job_id: jobA }, { folder: 'Party', job_id: randomUUID() }] })).toEqual({ updated: 1 });
      let rows = Object.fromEntries((await folders(s.id)).map(row => [row.folder, row.job_id]));
      expect(rows).toEqual({ '3612 Smith': jobA, '4170 Jones': jobB, Party: null });
      // The employee clears it; a later rescan does not bring the suggestion back for a row it did not make.
      await rpc('migration_folder_update', patch(s.id, '3612 Smith', { job_id: null }));
      const second = await seal(s.id, [entry('3612 Smith/a.jpg'), entry('4170 Jones/b.jpg'), entry('Party/c.jpg'), entry('3612 Smith/New/d.jpg')]);
      expect(await rpc('migration_folder_suggest', { p_source: s.id, p_scan: second, p_rows: [
        { folder: '3612 Smith', job_id: jobA }, { folder: '3612 Smith/New', job_id: jobA }] })).toEqual({ updated: 1 });
      rows = Object.fromEntries((await folders(s.id)).map(row => [row.folder, row.job_id]));
      expect(rows).toEqual({ '3612 Smith': null, '3612 Smith/New': jobA, '4170 Jones': jobB, Party: null });
      expect(await refused('migration_folder_suggest', { p_source: s.id, p_scan: second, p_rows: Array.from({ length: 1001 }, () => ({ folder: 'x', job_id: jobA })) })).toBe('invalid_input');
    });

    it('an imported photo takes its row’s project and tags, whatever the request says', async () => {
      const id = await batch(); const s = await source(id); await seal(s.id, [entry('Shop/x.jpg'), entry('Bare/y.jpg')]);
      await rpc('migration_folder_update', patch(s.id, 'Shop', { job_id: jobB, tags: ['shop drawing'] }));
      await action(id, 'approve'); await action(id, 'resume');
      const all = await items(s.id);
      const shop = await commit(all.find(item => item.relative_path === 'Shop/x.jpg')!, { kind: 'image', tags: ['smuggled'] });
      const bare = await commit(all.find(item => item.relative_path === 'Bare/y.jpg')!, { kind: 'image', tags: ['smuggled'] });
      expect(await photoRow(shop.ready.photo_id)).toEqual({ job_id: jobB, tags: ['shop drawing'] });
      expect(await photoRow(bare.ready.photo_id)).toEqual({ job_id: null, tags: [] });
      expect(shop.result.job_id).toBe(jobB); expect(bare.result.job_id).toBeNull();
    });

    it('an item sealed before folder rows existed imports exactly as it used to', async () => {
      const id = await batch(); const s = await source(id, { job: jobA }); await seal(s.id, [entry('Old/x.jpg')]);
      await f.sql.query('delete from public.migration_folders where source_id=$1', [s.id]);
      await action(id, 'approve'); await action(id, 'resume');
      const done = await commit((await items(s.id))[0], { kind: 'image', tags: ['from-request'] });
      expect(await photoRow(done.ready.photo_id)).toEqual({ job_id: jobA, tags: ['from-request'] });
      expect((await f.sql.query('select count(*)::int as n from public.album_photos where photo_id=$1', [done.ready.photo_id])).rows[0].n).toBe(0);
    });

    it('stays usable at 5,000 folders: seal, rescan, and a choice on the picked folder', async () => {
      const id = await batch(); const s = await source(id, { label: 'Wide tree' });
      const scanId = randomUUID(); await rpc('migration_scan', { p_source: s.id, p_scan: scanId });
      // 5,000 folders, 50 top-level x 100 inside each, two photos apiece. Descriptors are made in Postgres.
      await f.sql.query(`with chunks as (
        select (n-1)/500 chunk_number, jsonb_agg(jsonb_build_object(
          'relative_path','Top '||((n-1)/200)||'/Folder '||((n-1)/2)||'/'||n||'.jpg','original_name',n||'.jpg','original_bytes',8,
          'source_mtime',1,'source_signature',n||':8:1','mime_type','image/jpeg','status','pending','warnings','[]'::jsonb,'sidecar',null) order by n) entries
        from generate_series(1,10000) n group by (n-1)/500
      ) insert into public.migration_inventory_chunks(source_id,scan_id,chunk_number,payload_digest,entry_count,encoded_bytes,total_bytes,entries)
        select $1,$2,chunk_number,encode(extensions.digest(entries::text,'sha256'),'hex'),jsonb_array_length(entries),octet_length(entries::text),jsonb_array_length(entries)*8,entries from chunks`, [s.id, scanId]);
      const sealWith = async (scan: string) => {
        const staged = await f.admin.from('migration_inventory_chunks').select('payload_digest').eq('source_id', s.id).eq('scan_id', scan).order('chunk_number');
        const started = performance.now();
        await rpc('migration_seal', { p_source: s.id, p_scan: scan, p_chunks: 20, p_job: null, p_entries: 10_000, p_bytes: 80_000,
          p_fingerprint: createHash('sha256').update(staged.data!.map(c => c.payload_digest).join('')).digest('hex') });
        return Math.round(performance.now() - started);
      };
      const firstMs = await sealWith(scanId);
      expect((await f.sql.query('select count(*)::int as n,sum(photo_count)::int as photos from public.migration_folders where source_id=$1', [s.id])).rows[0]).toEqual({ n: 5000, photos: 10_000 });
      // A rescan of the same tree: every one of the 5,000 rows already exists.
      const rescan = randomUUID(); await rpc('migration_scan', { p_source: s.id, p_scan: rescan });
      await f.sql.query(`insert into public.migration_inventory_chunks(source_id,scan_id,chunk_number,payload_digest,entry_count,encoded_bytes,total_bytes,entries)
        select source_id,$2,chunk_number,payload_digest,entry_count,encoded_bytes,total_bytes,entries from public.migration_inventory_chunks where source_id=$1 and scan_id=$3`, [s.id, rescan, scanId]);
      const rescanMs = await sealWith(rescan);
      const choiceStarted = performance.now();
      expect(await rpc('migration_folder_update', patch(s.id, '', { job_id: jobA, tags: ['professional'] }, true))).toEqual({ updated: 5000 });
      const choiceMs = Math.round(performance.now() - choiceStarted);
      expect(await rpc('migration_folder_update', patch(s.id, 'Top 7', { job_id: jobB }, true))).toEqual({ updated: 100 });
      expect((await f.sql.query('select count(*)::int as n from public.migration_folders where source_id=$1 and job_id=$2', [s.id, jobB])).rows[0].n).toBe(100);
      console.info('IMPORT_5000_FOLDERS_BENCHMARK', JSON.stringify({ folders: 5000, items: 10_000, first_seal_ms: firstMs, rescan_seal_ms: rescanMs, choice_on_picked_folder_ms: choiceMs }));
      for (const ms of [firstMs, rescanMs, choiceMs]) expect(ms).toBeLessThan(5000);
      await action(id, 'cancel');
    }, 120_000);
  });

  describe('AC-18: loose files need a project or an album, new or existing', () => {
    const loose = async (job: string | null = null) => {
      const id = await batch('add_photos'); const s = await source(id, { job, kind: 'files', label: 'Selected files' });
      await seal(s.id, [entry('party-1.jpg'), entry('party-2.jpg')]);
      return { id, s };
    };
    it('refuses to start with neither, and says so as invalid_input', async () => {
      const { id, s } = await loose();
      expect(await folders(s.id)).toEqual([expect.objectContaining({ folder: '', album_name: null, album_id: null, job_id: null, photo_count: 2 })]);
      expect(await refused('migration_batch_action', { p_batch: id, p_action: 'approve' })).toBe('invalid_input');
      expect((await f.admin.from('migration_batches').select('status').eq('id', id).single()).data?.status).toBe('draft');
    });
    it('a project alone is enough, and makes no album', async () => {
      const { id, s } = await loose(jobA);
      await action(id, 'approve'); await action(id, 'resume');
      const done = await commit((await items(s.id))[0]);
      expect((await photoRow(done.ready.photo_id))!.job_id).toBe(jobA);
      expect((await folders(s.id))[0].album_id).toBeNull();
    });
    it('a new album alone is enough: created once, photos in it, no project', async () => {
      const name = `Christmas Party ${randomUUID()}`; const { id, s } = await loose();
      await rpc('migration_folder_update', patch(s.id, '', { album_name: name }));
      expect(await albumsNamed(name)).toEqual([]);
      await action(id, 'approve'); await action(id, 'resume');
      const done = []; for (const item of await items(s.id)) done.push(await commit(item));
      const [album] = await albumsNamed(name);
      expect(await albumsNamed(name)).toHaveLength(1);
      expect(await membersOf(album)).toEqual(done.map(d => d.ready.photo_id).sort());
      for (const d of done) expect((await photoRow(d.ready.photo_id))!.job_id).toBeNull();
    });
    it('an existing album alone is enough, and no second album is made', async () => {
      const name = `Marketing ${randomUUID()}`; const existing = (await rpc('photo_create_album', { p_name: name })).album.id as string;
      const { id, s } = await loose();
      await rpc('migration_folder_update', patch(s.id, '', { album_id: existing }));
      expect((await folders(s.id))[0]).toMatchObject({ album_id: existing, album_name: null });
      await action(id, 'approve'); await action(id, 'resume');
      const done = await commit((await items(s.id))[0]);
      expect(await membersOf(existing)).toEqual([done.ready.photo_id]);
      expect(await albumsNamed(name)).toEqual([existing]);
    });
    it('choosing a new name clears a chosen album and the reverse; a deleted album cannot be chosen or approved', async () => {
      const existing = (await rpc('photo_create_album', { p_name: `Pick ${randomUUID()}` })).album.id as string;
      const { id, s } = await loose();
      await rpc('migration_folder_update', patch(s.id, '', { album_id: existing }));
      await rpc('migration_folder_update', patch(s.id, '', { album_name: 'Typed instead' }));
      expect((await folders(s.id))[0]).toMatchObject({ album_id: null, album_name: 'Typed instead' });
      await rpc('migration_folder_update', patch(s.id, '', { album_id: existing }));
      expect((await folders(s.id))[0]).toMatchObject({ album_id: existing, album_name: null });
      expect(await refused('migration_folder_update', patch(s.id, '', { album_id: existing, album_name: 'Both' }))).toBe('invalid_input');
      await rpc('photo_delete_album', { p_album: existing });
      expect(await refused('migration_batch_action', { p_batch: id, p_action: 'approve' })).toBe('invalid_input');
      expect(await refused('migration_folder_update', patch(s.id, '', { album_id: existing }))).toBe('invalid_input');
      await rpc('migration_folder_update', patch(s.id, '', { album_id: null }));
      expect(await refused('migration_batch_action', { p_batch: id, p_action: 'approve' })).toBe('invalid_input');
    });
  });
});
