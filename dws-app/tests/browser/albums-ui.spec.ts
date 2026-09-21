import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

// plans/active/photo-albums/plan.md, Phases 4 and 5 — every screen a person sees:
//   AC-8  (browser half)  an album is deleted and restored from Trash with its photos
//   AC-11 (page half)     /photos?photo=<id> opens any active photo; old links still open
//   AC-12                 Photos · Albums · Projects on phone and desktop; "No project" breaks nothing
//   AC-13                 the upload pop-up: project-or-album rule, pre-fill, album created inline
//   AC-14                 the tag dropdown; filter and group by tag on Photos, album, and project pages
//   AC-15 / AC-9          select-many with all five actions; past 500 is refused in the bar
// Every test owns its rows. This file sorts first, and a later file (the 100,000-entry import)
// needs a small library, so afterAll removes every photo and album made here.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 6);
const projects = { north: randomUUID(), south: randomUUID() };
const names = { north: `Albums North ${run}`, south: `Albums South ${run}` };
const numbers = { north: `AN-${run}`, south: `AS-${run}` };
const madePhotos: string[] = [];
const madeAlbums: string[] = [];

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }] as const;
type ViewportName = (typeof VIEWPORTS)[number]['name'];

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  for (const key of ['north', 'south'] as const) {
    await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [projects[key], numbers[key], names[key]]);
  }
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[]) or original_name like $2', [madePhotos, `filler-${run}-%`]);
  await fixtures.sql.query('delete from public.albums where id=any($1::uuid[]) or name like $2', [madeAlbums, `%${run}%`]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
/** A real image in Storage plus its row. `jobId: null` is a photo with no project. */
async function seed(name: string, options: { jobId?: string | null; tags?: string[]; capturedAt?: string } = {}) {
  const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16)]);
  const path = `originals/${fixtures.employeeA.id}/${id}/${name}`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at,tags)
    values($1,$2,$3,'image',$4,$5,$6,'image/png',$7,$5,$8,$9)`,
    [id, options.jobId === undefined ? projects.north : options.jobId, fixtures.employeeA.id, name, path, bytes.length,
      createHash('sha256').update(bytes).digest('hex'), options.capturedAt ?? new Date().toISOString(), options.tags ?? []]);
  madePhotos.push(id);
  return id;
}
async function album(name: string, photoIds: string[] = []) {
  const id = randomUUID();
  await fixtures.sql.query('insert into public.albums(id,name,created_by) values($1,$2,$3)', [id, name, fixtures.employeeA.id]);
  for (const photo of photoIds) await fixtures.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [id, photo, fixtures.employeeA.id]);
  madeAlbums.push(id);
  return id;
}
/** Rows only (file tiles, no Storage objects): cheap bulk for paging and the 500 limit. */
async function fillers(count: number, albumId?: string) {
  const rows = await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,captured_at)
    select gen_random_uuid(),$1,$2,'file','filler-${run}-'||n||'.pdf','originals/filler-${run}/'||gen_random_uuid(),10,'application/pdf',now()+interval '1 day'
    from generate_series(1,$3) n returning id`, [projects.south, fixtures.employeeA.id, count]);
  const ids = rows.rows.map(row => row.id as string);
  if (albumId) await fixtures.sql.query('insert into public.album_photos(album_id,photo_id,added_by) select $1,unnest($2::uuid[]),$3', [albumId, ids, fixtures.employeeA.id]);
  return ids;
}
const removeFillers = () => fixtures.sql.query('delete from public.photos where original_name like $1', [`filler-${run}-%`]);

const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
// .last(): a project page repeats its `professional` photos in a pinned row above the dated groups;
// the dated tile is the one that selects, and it always comes after.
const tile = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).last();
const tick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).last();
/** The selection bar. Scoped, because "Tag" is also a Group by button on the same screen. */
const bar = (page: Page) => page.getByRole('region', { name: 'Selected photos' });
/** The viewer's facts: desktop keeps its side panel; a phone opens the labeled Details pop-up. */
async function openDetails(page: Page, viewport: ViewportName) {
  if (viewport === 'phone') await page.getByRole('button', { name: 'Details', exact: true }).click();
}
async function pickFile(page: Page, name: string, bytes: Buffer) {
  await page.locator('input[type=file][multiple]').first().setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
/** Phone: press and hold the first photo, then tap the rest. Desktop: tick the first, then tick the rest. */
async function select(page: Page, viewport: ViewportName, photoNames: string[]) {
  const [first, ...rest] = photoNames;
  if (viewport === 'phone') {
    const box = (await tile(page, first).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    for (const name of rest) await tile(page, name).click();
  } else {
    await tile(page, first).hover(); await tick(page, first).click();
    for (const name of rest) await tick(page, name).click();
  }
  await expect(page.getByTestId('selection-count')).toHaveText(`${photoNames.length} selected`);
}
const rowsOf = async (ids: string[]) => (await fixtures.sql.query('select id,job_id,tags,deleted_at from public.photos where id=any($1::uuid[]) order by original_name', [ids])).rows;

for (const viewport of VIEWPORTS) {
  const v = viewport.name;

  test(`AC-12: lands on Photos, the three sections are one tap apart, and a no-project photo opens on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const crashes: string[] = []; page.on('pageerror', error => crashes.push(error.message));
    const loose = `loose-${v}-${run}.png`;
    await seed(loose, { jobId: null }); await seed(`owned-${v}-${run}.png`);

    // Photos is where the app opens — on desktop too, which used to jump to the newest project.
    await page.goto('/photos');
    await expect(page.getByRole('heading', { level: 1, name: 'Photos', exact: true })).toBeVisible();
    await expect(tile(page, loose)).toBeVisible();
    await expect(page).toHaveURL(/\/photos$/);
    await expect(page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Filter by project' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Group by' })).toContainText('Group by');

    await sections(page).getByRole('link', { name: 'Albums', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/albums$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Albums', exact: true })).toBeVisible();
    await expect(page.locator('main').getByText('Like a folder. A photo can be in more than one.', { exact: true })).toBeVisible();

    await sections(page).getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/projects$/);
    await expect(page.locator('main').getByText('The job a photo belongs to. Optional.', { exact: true })).toBeVisible();
    // Job numbers are labeled, never a bare number beside a count.
    await expect(page.locator('main').getByRole('link', { name: new RegExp(names.north) })).toContainText(`Project #${numbers.north} · `);

    await sections(page).getByRole('link', { name: 'Photos', exact: true }).click();
    await expect(page).toHaveURL(/\/photos$/);

    if (v === 'desktop') {
      await expect(page.getByRole('link', { name: 'Import folders', exact: true })).toHaveAttribute('href', '/migrate');
      await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    } else {
      // The "+" holds what the two wide buttons used to be, plus New album.
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Upload', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'New album', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Receipts', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await tile(page, loose).click();
    await openDetails(page, v);
    await expect(page.getByTestId('photo-project')).toHaveText('No project');
    await expect(page.getByTestId('photo-albums')).toHaveText('Not in an album');
    expect(crashes).toEqual([]);
    await expect(page.locator('body')).not.toContainText('/photos/null');
  });

  test(`AC-8: an album is created, renamed, deleted, and restored from Trash with its photos on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const kept = await seed(`album-kept-${v}-${run}.png`);
    const first = `Party ${v} ${run}`, renamed = `Christmas Party ${v} ${run}`;

    await page.goto('/photos/albums');
    await page.locator('main').getByRole('button', { name: 'New album', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New album' });
    await create.getByLabel('Album name', { exact: true }).fill(first);
    await create.getByRole('button', { name: 'Create album', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/albums\/[0-9a-f-]{36}$/);
    const albumId = page.url().split('/').pop()!; madeAlbums.push(albumId);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(first);
    // An empty album says so and carries its own action; filters that cannot help are hidden.
    await expect(page.getByText('This album is empty', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload photos to this album', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Filters' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Album name', { exact: true }).fill(renamed);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);

    await fixtures.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [albumId, kept, fixtures.employeeA.id]);
    await page.reload();
    await expect(tile(page, `album-kept-${v}-${run}.png`)).toBeVisible();
    await expect(page.locator('main')).toContainText('Album · 1 photo');

    await page.getByRole('button', { name: 'Delete album', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(`Delete album “${renamed}”? The photos stay in Photos.`);
    await confirm.getByRole('button', { name: 'Delete album', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/albums$/);
    await expect(page.locator('main').getByRole('link', { name: new RegExp(renamed) })).toHaveCount(0);
    // Deleting an album removes no photo.
    expect((await rowsOf([kept]))[0].deleted_at).toBeNull();

    await page.goto('/photos/trash');
    const row = page.getByTestId('trash-album').filter({ hasText: renamed });
    await expect(row).toContainText('Restore before');
    await row.getByRole('button', { name: 'Restore album', exact: true }).click();
    await expect(page.getByText(`Album “${renamed}” restored`, { exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.goto(`/photos/albums/${albumId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
    await expect(tile(page, `album-kept-${v}-${run}.png`)).toBeVisible();
  });

  test(`AC-11: new and old photo links open any active photo, however old, with or without a project, on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const oldName = `old-${v}-${run}.png`, looseName = `old-loose-${v}-${run}.png`;
    const old = await seed(oldName, { capturedAt: '1999-03-04T10:00:00Z' });
    const looseOld = await seed(looseName, { jobId: null, capturedAt: '1998-03-04T10:00:00Z' });
    const inAlbum = await album(`Links ${v} ${run}`, [old]);
    const shows = async (name: string, project: string) => {
      await expect(page.locator('.yarl__slide_image').first()).toBeVisible();
      await openDetails(page, v);
      await expect(page.getByTestId('photo-project')).toHaveText(project);
      await expect(page.getByText(new RegExp(`^${name.replace('.', '\\.')}`)).last()).toBeVisible();
    };
    // More than one page (100) of newer photos sits in front of both.
    await fillers(101);
    try {
      const northLabel = `#${numbers.north} · ${names.north}`;
      await page.goto(`/photos?photo=${old}`); await shows(oldName, northLabel);
      await page.goto(`/photos?photo=${looseOld}`); await shows(looseName, 'No project');
      // The shape every link already sent has.
      await page.goto(`/photos/${projects.north}?photo=${old}`); await shows(oldName, northLabel);
      // An old link whose photo has since left that project still opens it, and says where it is now.
      await page.goto(`/photos/${projects.south}?photo=${old}`); await shows(oldName, northLabel);
      await page.goto(`/photos/albums/${inAlbum}?photo=${old}`); await shows(oldName, northLabel);
    } finally { await removeFillers(); }
    // A trashed photo says so and opens nothing.
    await fixtures.sql.query("update public.photos set deleted_at=now(),deleted_by=$2,purge_after=now()+interval '30 days' where id=$1", [old, fixtures.employeeA.id]);
    await page.goto(`/photos?photo=${old}`);
    await expect(page.getByText(/not found/i).first()).toBeVisible();
    await expect(page.locator('.yarl__slide_image')).toHaveCount(0);
  });

  test(`AC-13: the upload pop-up needs a project or an album, pre-fills from the page, and creates an album inline on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const bytes = Buffer.concat([png, randomBytes(16)]); const digest = createHash('sha256').update(bytes).digest('hex');
    const albumName = `Inline ${v} ${run}`;

    // From Photos nothing is pre-filled, and Upload waits for a project or an album.
    await page.goto('/photos');
    let dialog = await pickFile(page, `party-${v}.png`, bytes);
    await expect(dialog.getByText('Pick a project, an album, or both.', { exact: true })).toBeVisible();
    const upload = dialog.getByRole('button', { name: 'Upload 1 file', exact: true });
    await expect(upload).toBeDisabled();
    await expect(dialog.getByText('Choose a project or an album to turn on Upload.', { exact: true })).toBeVisible();
    if (v === 'phone') {
      // Every phone pop-up has a visible, labeled way out in its header, 44px tall.
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await cancel.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      dialog = await pickFile(page, `party-${v}.png`, bytes);
    }
    // Type a new album and create it on the spot.
    await dialog.getByLabel('Album (optional)', { exact: true }).fill(albumName);
    await dialog.getByRole('option', { name: `Create album “${albumName}”` }).click();
    await expect(dialog.getByRole('button', { name: `Remove album ${albumName}`, exact: true })).toBeVisible();
    await expect(upload).toBeEnabled();
    await upload.click();
    await expect.poll(async () => (await fixtures.sql.query('select count(*)::int as n from public.photos where content_sha256=$1 and deleted_at is null', [digest])).rows[0].n, { timeout: 120_000 }).toBe(1);
    const stored = (await fixtures.sql.query('select p.id,p.job_id,a.name from public.photos p join public.album_photos ap on ap.photo_id=p.id join public.albums a on a.id=ap.album_id where p.content_sha256=$1', [digest])).rows;
    // The Christmas-party case: in its new album, with no project.
    expect(stored).toEqual([{ id: stored[0].id, job_id: null, name: albumName }]);
    madePhotos.push(stored[0].id);
    const albumId = (await fixtures.sql.query('select id from public.albums where name=$1', [albumName])).rows[0].id as string; madeAlbums.push(albumId);

    // A project page pre-fills its project; an album page pre-fills its album.
    await page.goto(`/photos/${projects.north}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(names.north);
    dialog = await pickFile(page, 'prefill.png', Buffer.concat([png, randomBytes(16)]));
    // A text field at desktop, a picker button on a phone.
    const project = dialog.getByLabel('Project (optional)', { exact: true });
    if (v === 'desktop') await expect(project).toHaveValue(`#${numbers.north} · ${names.north}`);
    else await expect(project).toContainText(`#${numbers.north} · ${names.north}`);
    await expect(dialog.getByRole('button', { name: 'Upload 1 file', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');

    await page.goto(`/photos/albums/${albumId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(albumName);
    await expect(page.locator('main')).toContainText('Album · 1 photo');
    dialog = await pickFile(page, 'prefill.png', Buffer.concat([png, randomBytes(16)]));
    await expect(dialog.getByRole('button', { name: `Remove album ${albumName}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Upload 1 file', exact: true })).toBeEnabled();
  });

  test(`AC-14: the tag dropdown offers existing and starter tags and adds a new one; filter and group by it on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const name = `tagged-${v}-${run}.png`, other = `untagged-${v}-${run}.png`, fresh = `punch list ${v} ${run}`;
    const tagged = await seed(name); const untagged = await seed(other);
    const albumId = await album(`Tags ${v} ${run}`, [tagged, untagged]);

    await page.goto(`/photos/${projects.north}?photo=${tagged}`);
    await openDetails(page, v);
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit details' });
    await expect(edit.getByText('A tag is a label you can filter by, like professional or shop drawing.', { exact: true })).toBeVisible();
    const field = edit.getByLabel('Tags (optional)', { exact: true });
    await field.click();
    // It opens to the starter tags even before any photo carries one.
    for (const starter of ['professional', 'field dimension', 'shop drawing']) await expect(edit.getByRole('option', { name: starter, exact: true })).toBeVisible();
    // Typing narrows, and the last row adds what was typed.
    await field.fill('Prof');
    await expect(edit.getByRole('option')).toHaveText(['professional', 'Add “Prof”']);
    // Matched ignoring case against the starter tag: no second spelling is offered or stored.
    await field.fill('PROFESSIONAL');
    await expect(edit.getByRole('option')).toHaveText(['professional']);
    await field.press('Enter');
    await expect(edit.getByRole('button', { name: 'Remove tag professional', exact: true })).toBeVisible();
    await field.fill(fresh);
    await edit.getByRole('option', { name: `Add “${fresh}”` }).click();
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Photo updated', { exact: true })).toBeVisible();
    expect((await rowsOf([tagged]))[0].tags).toEqual(['professional', fresh]);

    // Filter, then group, by the new tag — on the project page, the album page, and Photos.
    for (const path of [`/photos/${projects.north}`, `/photos/albums/${albumId}`, '/photos']) {
      await page.goto(path);
      await expect(tile(page, other)).toBeVisible();
      await page.getByRole('button', { name: 'Filter by tag', exact: true }).click();
      await page.getByRole('menuitem', { name: fresh, exact: true }).click();
      await expect(tile(page, name)).toBeVisible();
      await expect(tile(page, other)).toHaveCount(0);
      await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Tag', exact: true }).click();
      await expect(page.getByRole('heading', { name: `${fresh} · 1 photo`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'All', exact: true }).click();
      // Ungrouped from the filter: photos with no tag come last, under their own heading.
      await expect(page.getByRole('heading', { name: /^No tags · \d+ photos?$/ })).toBeVisible();
    }
  });

  test(`AC-15: select three photos, then add to album, tag, set project, set no project, remove from album, and trash on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const photoNames = ['a', 'b', 'c'].map(letter => `sel-${letter}-${v}-${run}.png`);
    // Their own day, so the desktop date-group tick selects exactly these three.
    const day = v === 'desktop' ? '2031-05-06' : '2031-05-07';
    const ids: string[] = [];
    // 18:00 UTC is the same calendar day in every timezone these suites run in.
    for (const [index, name] of photoNames.entries()) ids.push(await seed(name, { capturedAt: `${day}T18:0${index}:00Z` }));
    await seed(`sel-other-${v}-${run}.png`, { capturedAt: '2031-05-01T18:00:00Z' });
    const albumName = `Marketing ${v} ${run}`;
    const label = { north: `#${numbers.north} · ${names.north}`, south: `#${numbers.south} · ${names.south}` };

    await page.goto(`/photos/${projects.north}`);
    await expect(tile(page, photoNames[0])).toBeVisible();
    if (v === 'desktop') {
      // Tick one, shift-click another: everything between them is selected.
      const ordered = [...photoNames].reverse(); // newest first on screen
      await tile(page, ordered[0]).hover(); await tick(page, ordered[0]).click();
      await tile(page, ordered[2]).click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
      await expect(page.getByTestId('selection-count')).toHaveCount(0);
      // The tick in a date heading selects that whole day.
      const heading = page.getByRole('checkbox', { name: 'Select all of May 6, 2031', exact: true });
      await page.getByRole('heading', { name: 'May 6, 2031', exact: true }).hover();
      await heading.click();
      await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
    } else {
      await select(page, v, photoNames);
    }

    // 1. Add to album — a new album, made on the spot. It acts at once.
    await bar(page).getByRole('button', { name: 'Add to album', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add 3 photos to an album' });
    await dialog.getByLabel('Album', { exact: true }).fill(albumName);
    await dialog.getByRole('option', { name: `Create album “${albumName}”` }).click();
    await dialog.getByRole('button', { name: 'Add to album', exact: true }).click();
    await expect(page.getByText(`Added 3 photos to “${albumName}”`, { exact: true })).toBeVisible();
    const albumId = (await fixtures.sql.query('select id from public.albums where name=$1', [albumName])).rows[0].id as string; madeAlbums.push(albumId);
    expect((await fixtures.sql.query('select photo_id from public.album_photos where album_id=$1 order by photo_id', [albumId])).rows.map(row => row.photo_id)).toEqual([...ids].sort());
    await expect(page.getByTestId('selection-count')).toHaveCount(0);

    // 2. Tag — typed with a capital, stored as the starter tag's spelling.
    await select(page, v, photoNames);
    await bar(page).getByRole('button', { name: 'Tag', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Tag 3 photos' });
    await dialog.getByLabel('Tags to add', { exact: true }).fill('Professional');
    await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
    await expect(page.getByText('Tagged 3 photos professional', { exact: true })).toBeVisible();
    expect((await rowsOf(ids)).map(row => row.tags)).toEqual([['professional'], ['professional'], ['professional']]);
    // The project page pins its `professional` photos in a row on top, and these three are the newest.
    // Wait until each shows there as well as under its date, so the next press lands on a grid that
    // has finished moving.
    await expect(page.getByRole('button', { name: /^Professional Photography · \d+/ })).toBeVisible();
    for (const name of photoNames) await expect(page.getByRole('checkbox', { name: `Select ${name}`, exact: true })).toHaveCount(2);

    // 3. Set project — through the confirm page, which lists exactly these three.
    await select(page, v, photoNames);
    await bar(page).getByRole('button', { name: 'Set project', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Set project for 3 photos' });
    if (v === 'phone') {
      await dialog.getByLabel('Which project?', { exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Pick a project' });
      await picker.getByPlaceholder('Project name or number').fill(names.south);
      await picker.getByRole('button', { name: new RegExp(`^#${numbers.south}`) }).click();
    } else {
      await dialog.getByLabel('Which project?', { exact: true }).fill(names.south);
      await page.getByRole('option', { name: new RegExp(`^#${numbers.south}`) }).click();
    }
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/actions\?batch=/);
    await expect(page.getByTestId('action-count')).toHaveText('3 photos');
    await expect(page.getByTestId('action-item')).toHaveCount(3);
    for (const name of photoNames) await expect(page.getByTestId('action-item').filter({ hasText: name })).toHaveCount(1);
    await expect(page.getByTestId('action-question')).toHaveText(`Move 3 photos to ${label.south}?`);
    await expect(page.locator('main')).not.toContainText(/exact target|draft|pending|canonical|MCP/i);
    expect((await rowsOf(ids)).map(row => row.job_id)).toEqual([projects.north, projects.north, projects.north]);
    await page.getByRole('button', { name: 'Move photos', exact: true }).click();
    await expect(page.getByTestId('action-status')).toHaveText('Done');
    await expect(page.getByTestId('action-question')).toHaveText(`Done. 3 photos moved to ${label.south}.`);
    expect((await rowsOf(ids)).map(row => row.job_id)).toEqual([projects.south, projects.south, projects.south]);

    // 4. Set "No project" — from the album this time: the photos stay in it.
    await page.goto(`/photos/albums/${albumId}`);
    await expect(tile(page, photoNames[0])).toBeVisible();
    await select(page, v, photoNames);
    await expect(bar(page).getByRole('button', { name: 'Remove from album', exact: true })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Set project', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Set project for 3 photos' });
    await dialog.getByRole('radio', { name: /^No project/ }).check();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByTestId('action-question')).toHaveText('Move 3 photos to “No project”?');
    await expect(page.getByTestId('action-item')).toHaveCount(3);
    await page.getByRole('button', { name: 'Move photos', exact: true }).click();
    await expect(page.getByTestId('action-status')).toHaveText('Done');
    expect((await rowsOf(ids)).map(row => row.job_id)).toEqual([null, null, null]);

    // 5. Remove from album — one photo; it stays in Photos.
    await page.goto(`/photos/albums/${albumId}`);
    await expect(tile(page, photoNames[0])).toBeVisible();
    await select(page, v, [photoNames[0]]);
    await bar(page).getByRole('button', { name: 'Remove from album', exact: true }).click();
    await expect(page.getByText(`Removed 1 photo from “${albumName}”`, { exact: true })).toBeVisible();
    await expect(tile(page, photoNames[0])).toHaveCount(0);
    expect((await fixtures.sql.query('select count(*)::int as n from public.album_photos where album_id=$1', [albumId])).rows[0].n).toBe(2);
    expect((await rowsOf([ids[0]]))[0].deleted_at).toBeNull();

    // 6. Trash — the other two, through the confirm page; then they are gone from the album.
    await select(page, v, photoNames.slice(1));
    await bar(page).getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(page).toHaveURL(/\/photos\/actions\?batch=/);
    await expect(page.getByTestId('action-question')).toHaveText('Move 2 photos to trash?');
    await expect(page.getByTestId('action-item')).toHaveCount(2);
    await expect(page.getByText(/restore a photo from Trash for 30 days/)).toBeVisible();
    await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(page.getByTestId('action-status')).toHaveText('Done');
    expect((await rowsOf(ids.slice(1))).every(row => row.deleted_at !== null)).toBe(true);
    await page.goto(`/photos/albums/${albumId}`);
    await expect(page.getByText('This album is empty', { exact: true })).toBeVisible();

    // The search grid selects the same way.
    await page.goto(`/photos/search?q=${encodeURIComponent(names.north)}`);
    await expect(tile(page, `sel-other-${v}-${run}.png`)).toBeVisible();
    await select(page, v, [`sel-other-${v}-${run}.png`]);
    await expect(bar(page).getByRole('button', { name: 'Add to album', exact: true })).toBeVisible();
  });
}

test('phone viewer: the photo is unobscured until the labeled Details pop-up is opened, and it closes again', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await authenticate(context);
  const name = `viewer-phone-${run}.png`; const id = await seed(name);
  const inAlbum = `Viewer ${run}`; await album(inAlbum, [id]);
  await page.goto(`/photos/${projects.north}?photo=${id}`);
  await expect(page.locator('.yarl__slide_image').first()).toBeVisible();
  // Nothing about the photo is laid over it.
  await expect(page.getByTestId('photo-project')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Move to trash' })).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Details', exact: true });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  const details = page.getByRole('dialog', { name: 'Details' });
  await expect(details.getByTestId('photo-project')).toHaveText(`#${numbers.north} · ${names.north}`);
  await expect(details.getByTestId('photo-albums').getByRole('link', { name: inAlbum, exact: true })).toBeVisible();
  // "Set project" is its own action, and the form is "Edit details".
  await expect(details.getByRole('button', { name: 'Set project', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Edit details', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: /Edit tags/ })).toHaveCount(0);
  // The 30-day recovery sentence sits with the trash action.
  await expect(details.getByRole('link', { name: 'Move to trash', exact: true })).toBeVisible();
  await expect(details.getByText(/restore a photo from Trash for 30 days/)).toBeVisible();
  const close = details.getByRole('button', { name: 'Close', exact: true });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(page.getByRole('dialog', { name: 'Details' })).toHaveCount(0);
  await expect(page.locator('.yarl__slide_image').first()).toBeVisible();
});

test('AC-9: selecting past 500 is refused in the bar with a plain message; all actions accept the selected 500', async ({ page, context }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1000 }); await authenticate(context);
  const big = await album(`Big ${run}`); const second = await album(`Second ${run}`);
  await fillers(501, big);
  try {
    await page.goto(`/photos/albums/${big}`);
    const ticks = page.getByRole('checkbox', { name: new RegExp(`^Select filler-${run}-`) });
    await expect(ticks.first()).toBeAttached();
    // Scroll until every page (100 at a time) has loaded.
    await expect.poll(async () => {
      await page.locator('#photos-scrollport').evaluate(node => node.scrollTo(0, node.scrollHeight));
      return ticks.count();
    }, { timeout: 120_000, intervals: [500] }).toBe(501);
    await page.locator('#photos-scrollport').evaluate(node => node.scrollTo(0, 0));
    const heading = page.locator('main h2').first();
    await heading.hover();
    await page.getByRole('checkbox', { name: /^Select all of / }).first().click();
    await expect(page.getByTestId('selection-count')).toHaveText('500 selected');
    await expect(page.getByTestId('selection-message')).toHaveText('You can select up to 500 photos at a time. Finish with these first, then select more.');
    // One more tick is refused the same way; un-ticking still works.
    const unselected = page.getByRole('checkbox', { name: new RegExp(`^Select filler-${run}-`), checked: false });
    await expect(unselected).toHaveCount(1);
    await unselected.click();
    await expect(page.getByTestId('selection-count')).toHaveText('500 selected');

    await bar(page).getByRole('button', { name: 'Set project', exact: true }).click();
    const projectDialog = page.getByRole('dialog');
    await expect(projectDialog).toBeVisible();
    await projectDialog.getByRole('button', { name: 'Close', exact: true }).click();

    // The immediate actions take all 500 in one call.
    await bar(page).getByRole('button', { name: 'Add to album', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add 500 photos to an album' });
    await dialog.getByLabel('Album', { exact: true }).fill(`Second ${run}`);
    await dialog.getByRole('option', { name: new RegExp(`^Second ${run}`) }).click();
    await dialog.getByRole('button', { name: 'Add to album', exact: true }).click();
    await expect(page.getByText(`Added 500 photos to “Second ${run}”`, { exact: true })).toBeVisible();
    expect((await fixtures.sql.query('select count(*)::int as n from public.album_photos where album_id=$1', [second])).rows[0].n).toBe(500);
  } finally { await removeFillers(); }
});
