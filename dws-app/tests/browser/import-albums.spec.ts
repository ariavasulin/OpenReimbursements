import { test, expect, type Page, type BrowserContext, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories, type DirectoryFixture } from './directory-fixture';

// plans/active/photo-albums/plan.md, Phase 6: folders import as albums, in a real browser.
// AC-16 (a tree with no edits), AC-7 (a folder of copies), AC-17 (a top-level choice; 5,000 rows),
// AC-20 (no hand-off needed; a browser that cannot open folders is told so).
//
// Every spec file shares one database, and a photo's identity is its bytes. The directory fixture
// derives bytes from (size, seed), so this file keeps to sizes 5000-5999, which no other file uses.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
let project4170: string;
const run = randomUUID().slice(0, 8);
let nextSize = 5000;
const photo = (name: string) => ({ name, bytes: nextSize++, seed: 5 });

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query("insert into public.jobs(job_number,name) values('3612','Office North'),('4170','Office South') on conflict(job_number) do nothing");
  project4170 = (await fixtures.sql.query("select id from public.jobs where job_number='4170'")).rows[0].id;
});
test.afterAll(async () => { await fixtures?.close(); });

async function signIn(context: BrowserContext, directories: DirectoryFixture[] | null) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  if (directories) await installDirectories(context, directories, png.toString('base64'));
}
async function chooseFolder(page: Page, label: string) {
  await page.getByRole('button', { name: /^Choose (another )?folder$/ }).click();
  const picked = page.getByTestId('migration-source').filter({ hasText: label });
  await expect(picked.getByTestId('source-counts')).toContainText(/photo/i, { timeout: 120_000 });
  return picked;
}
/** `main` scrolls inside itself, so a full-page capture must let it grow, or everything below the fold is cut off. */
const WHOLE_PAGE = 'main { height: auto !important; overflow: visible !important; } div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }';
async function shoot(page: Page, info: TestInfo, name: string) {
  await page.locator('main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, style: WHOLE_PAGE });
}

// When a test fails, say what the page was waiting on. A trace only lists requests that FINISHED and
// only snapshots the page at test actions, so a request that hangs, or an error banner that appears
// while the test waits, is invisible in it.
const watched = new WeakMap<Page, Map<string, number>>();
function watch(page: Page) {
  const pending = new Map<string, number>(); watched.set(page, pending);
  const key = (request: { method(): string; url(): string }) => `${request.method()} ${new URL(request.url()).pathname}`;
  page.on('request', request => { if (request.url().includes('/api/')) pending.set(key(request), Date.now()); });
  page.on('requestfinished', request => pending.delete(key(request)));
  page.on('requestfailed', request => pending.delete(key(request)));
}
test.beforeEach(async ({ page }) => watch(page));
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const pending = [...(watched.get(page) ?? [])].map(([request, since]) => `${request} (unanswered for ${Math.round((Date.now() - since) / 1000)}s)`);
  const said = await page.locator('main [role="alert"], main [role="status"]').allInnerTexts().catch(() => []);
  await info.attach('what-the-page-was-doing', { contentType: 'application/json',
    body: JSON.stringify({ unansweredRequests: pending, messagesOnScreen: said.filter(Boolean), url: page.url() }, null, 2) });
  console.info('FAILED_TEST_PAGE_STATE', info.title, JSON.stringify({ unansweredRequests: pending, messagesOnScreen: said.filter(Boolean) }));
});
const status = (page: Page) => page.getByTestId('batch-status');
const latestBatch = async () => (await fixtures.sql.query('select id from public.migration_batches where created_by=$1 order by created_at desc limit 1', [fixtures.employeeA.id])).rows[0].id as string;
/** Every album whose name starts with this run's prefix, with the file names inside it. */
async function albums(prefix: string) {
  return (await fixtures.sql.query(`select a.name,coalesce(array_agg(p.original_name order by p.original_name) filter(where p.id is not null),'{}') as photos
    from public.albums a left join public.album_photos ap on ap.album_id=a.id left join public.photos p on p.id=ap.photo_id
    where a.name like $1 group by a.id,a.name order by a.name`, [`${prefix}%`])).rows as Array<{ name: string; photos: string[] }>;
}

test('AC-16/AC-17: a three-level tree imports with no edits to names, and a top-level choice reaches the folders inside', async ({ page, context }, info) => {
  const root = `Drive ${run}`;
  const tree: DirectoryFixture = { label: root, files: [photo('loose.png')], folders: [
    { label: 'Smith Residence', folders: [
      { label: 'Finished', files: [photo('finished-1.png'), photo('finished-2.png')] },
      { label: 'Before', files: [photo('before-1.png')], folders: [{ label: 'Demo', files: [photo('demo-1.png')] }] },
    ] },
    { label: 'Christmas Party 2015', files: [photo('party-1.png')] },
    // Nothing importable in here: Picasa's own files are left out, so this folder gets no row and no album.
    { label: 'Only Picasa files', files: [photo('.picasa.ini')], folders: [{ label: '.picasaoriginals', files: [photo('backup.png')] }] },
  ] };
  await signIn(context, [tree]);
  await page.goto('/migrate');
  await expect(page.getByRole('heading', { level: 1, name: 'Import folders' })).toBeVisible();
  await expect(page.getByText('Each folder becomes an album with the same name.', { exact: true })).toBeVisible();
  const picked = await chooseFolder(page, root);
  await expect(picked.getByTestId('source-counts')).toHaveText('5 folders with photos · 6 photos');
  // Collapsed by top-level folder, with counts. The picked folder's own photos and a single-folder group are plain rows.
  const group = picked.getByTestId('folder-group');
  await expect(group).toHaveCount(1);
  await expect(group.getByRole('button', { expanded: false })).toContainText('Smith Residence'); await expect(group).toContainText('3 folders · 4 photos');
  await expect(picked.getByTestId('folder-row')).toHaveCount(2);
  await expect(picked.getByRole('textbox', { name: `Album name for Photos directly in ${root}`, exact: true })).toHaveValue(root);
  await expect(picked.getByRole('textbox', { name: 'Album name for Christmas Party 2015', exact: true })).toHaveValue('Christmas Party 2015');
  await expect(picked).not.toContainText('Only Picasa files');
  await shoot(page, info, 'tree-collapsed');

  await group.getByRole('button', { expanded: false }).click();
  await expect(group.getByTestId('folder-row')).toHaveCount(3);
  await expect(group.getByRole('textbox', { name: 'Album name for Smith Residence / Before / Demo', exact: true })).toHaveValue('Smith Residence – Before – Demo');
  // AC-17: one choice on the top-level folder, which holds no photos itself, applies to all three folders inside it.
  const inside = group.getByRole('group', { name: 'For every folder in Smith Residence' });
  await inside.getByRole('button', { name: /^Project for every folder in Smith Residence:/ }).click();
  await inside.getByLabel('Find a project by number or name').fill('Office South');
  await inside.getByRole('option', { name: '4170 · Office South', exact: true }).getByRole('button').click();
  await inside.getByRole('textbox', { name: 'Tags for every folder in Smith Residence', exact: true }).click();
  await inside.getByRole('button', { name: 'professional', exact: true }).click();
  for (const album of ['Smith Residence – Before', 'Smith Residence – Before – Demo', 'Smith Residence – Finished']) {
    await expect(group.getByRole('button', { name: `Project for ${album}: 4170 · Office South`, exact: true })).toBeVisible();
    await expect(group.getByRole('button', { name: 'Remove tag professional', exact: true })).toHaveCount(4); // the whole-folder control + 3 rows
  }
  // Folders outside it are untouched.
  await expect(picked.getByRole('button', { name: 'Project for Christmas Party 2015: No project', exact: true })).toBeVisible();
  await shoot(page, info, 'tree-top-level-choice');

  // Nothing exists yet. Then Start, with no album name edited.
  // REGRESSION: focus is still in a Tags field here. Its suggestions used to push the page down, so
  // they vanished on mouse-down, "Start import" jumped up before mouse-up, and the click was lost:
  // nothing was sent and nothing was said. The suggestions now float, so this click must land.
  expect(await albums(root)).toEqual([]);
  await page.getByRole('button', { name: 'Start import', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
  const smith = (name: string) => ({ name: `Smith Residence – ${name}` });
  const made = [...await albums(root), ...await albums('Smith Residence –'), ...await albums('Christmas Party 2015')];
  expect(made).toEqual(expect.arrayContaining([
    { name: root, photos: ['loose.png'] }, { name: 'Christmas Party 2015', photos: ['party-1.png'] },
    { ...smith('Before'), photos: ['before-1.png'] }, { ...smith('Before – Demo'), photos: ['demo-1.png'] }, { ...smith('Finished'), photos: ['finished-1.png', 'finished-2.png'] },
  ]));
  expect(await albums('Only Picasa files')).toEqual([]);
  const batch = await latestBatch();
  const imported = (await fixtures.sql.query(`select p.original_name,p.job_id,p.tags from public.photos p join public.migration_items i on i.photo_id=p.id
    join public.migration_sources s on s.id=i.source_id where s.batch_id=$1 order by p.original_name`, [batch])).rows;
  expect(imported).toEqual([
    { original_name: 'before-1.png', job_id: project4170, tags: ['professional'] }, { original_name: 'demo-1.png', job_id: project4170, tags: ['professional'] },
    { original_name: 'finished-1.png', job_id: project4170, tags: ['professional'] }, { original_name: 'finished-2.png', job_id: project4170, tags: ['professional'] },
    // The party and the loose photo have no project at all (Decision 1), and that broke nothing.
    { original_name: 'loose.png', job_id: null, tags: [] }, { original_name: 'party-1.png', job_id: null, tags: [] },
  ]);
  await shoot(page, info, 'tree-finished');

  // Reopen, choose the same folder again (a rescan), and nothing is duplicated: not a photo, not an album.
  const before = { albums: made.length, photos: imported.length };
  await page.goto(`/migrate?batch=${batch}`);
  await page.getByRole('button', { name: `Choose ${root} again`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Choose ${root} again`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
  expect([...await albums(root), ...await albums('Smith Residence –'), ...await albums('Christmas Party 2015')]).toHaveLength(before.albums);
  expect((await fixtures.sql.query('select count(*)::int as n from public.photos p join public.migration_items i on i.photo_id=p.id join public.migration_sources s on s.id=i.source_id where s.batch_id=$1', [batch])).rows[0].n).toBe(before.photos);
});

test('AC-7: a "Marketing" folder of copies becomes an album of the existing photos, with no new photo rows', async ({ page: firstPage, context, browser }, info) => {
  const copies = [photo('kitchen.png'), photo('stair.png')];
  const originals = `Originals 4170 ${run}`, marketing = `Marketing ${run}`;
  await signIn(context, [{ label: originals, files: copies }]);
  let page = firstPage;
  await page.goto('/migrate');
  await chooseFolder(page, originals);
  await page.getByRole('button', { name: 'Start import', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
  const photosBefore = (await fixtures.sql.query('select count(*)::int as n from public.photos')).rows[0].n as number;
  const existing = (await fixtures.sql.query("select id from public.photos where original_name in ('kitchen.png','stair.png') and job_id=$1 order by original_name", [project4170])).rows.map(row => row.id as string);
  expect(existing).toHaveLength(2);

  // A second visit, with a different folder to pick: the same bytes under other names, as a folder
  // of hand-picked copies would be. (The picker fixture is set per browser context.)
  const second = await browser.newContext({ baseURL: process.env.DWS_BROWSER_BASE_URL, viewport: { width: 1440, height: 1000 } });
  await signIn(second, [{ label: marketing, files: [{ ...copies[0], name: 'best-kitchen.png' }, { ...copies[1], name: 'best-stair.png' }] }]);
  page = await second.newPage(); watch(page);
  await page.goto('/migrate');
  await chooseFolder(page, marketing);
  await page.getByRole('button', { name: 'Start import', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
  // No new photo rows...
  expect((await fixtures.sql.query('select count(*)::int as n from public.photos')).rows[0].n).toBe(photosBefore);
  // ...and the Marketing album holds the photos that already existed, which keep their project.
  expect(await albums(marketing)).toEqual([{ name: marketing, photos: ['kitchen.png', 'stair.png'] }]);
  const members = (await fixtures.sql.query('select ap.photo_id,p.job_id from public.album_photos ap join public.albums a on a.id=ap.album_id join public.photos p on p.id=ap.photo_id where a.name=$1 order by p.original_name', [marketing])).rows;
  expect(members).toEqual(existing.map(photo_id => ({ photo_id, job_id: project4170 })));
  // The screen says so in plain words, not "skipped duplicate".
  const rows = page.getByTestId('migration-item');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toContainText('Already in DWS Photos');
    await expect(row).toContainText('The photo you already have was added to the album.');
  }
  await expect(page.getByTestId('batch-counts')).toContainText('2 already in DWS Photos');
  await shoot(page, info, 'marketing-copies');
  await second.close();
});

test('AC-17: 5,000 folder rows stay usable: review scrolls, finds, and edits', async ({ page, context }, info) => {
  test.setTimeout(420_000);
  const root = `Wide ${run}`;
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  // 50 top-level folders x 100 folders inside each x 1 photo. Metadata only: nothing is uploaded here.
  const tree: DirectoryFixture = { label: root, folders: Array.from({ length: 50 }, (_, top) => ({
    label: `Group ${pad(top, 2)}`, folders: Array.from({ length: 100 }, (_, n) => ({ label: `Set ${pad(top * 100 + n, 4)}`, count: 1, metadataOnly: true })),
  })) };
  await signIn(context, [tree]);
  await page.goto('/migrate');
  const picked = await chooseFolder(page, root);
  await expect(picked.getByTestId('source-counts')).toHaveText('5,000 folders with photos · 5,000 photos', { timeout: 300_000 });
  // Collapsed, 5,000 rows are 50 buttons: the page holds no row at all yet.
  await expect(picked.getByTestId('folder-group')).toHaveCount(50);
  await expect(picked.getByTestId('folder-row')).toHaveCount(0);
  await shoot(page, info, 'five-thousand-collapsed');

  // Scroll to the very last group, open it, and edit a row in it.
  const last = picked.getByTestId('folder-group').last();
  await last.scrollIntoViewIfNeeded();
  const opened = Date.now();
  await last.getByRole('button', { expanded: false }).click();
  await expect(last.getByTestId('folder-row')).toHaveCount(100);
  const openMs = Date.now() - opened;
  const name = last.getByRole('textbox', { name: 'Album name for Group 49 / Set 4999', exact: true });
  await name.scrollIntoViewIfNeeded();
  await name.fill('The very last folder'); await name.press('Enter');
  const batch = await latestBatch();
  const stored = (folder: string) => fixtures.sql.query('select f.album_name,f.tags from public.migration_folders f join public.migration_sources s on s.id=f.source_id where s.batch_id=$1 and f.folder=$2', [batch, folder]);
  await expect.poll(async () => (await stored('Group 49/Set 4999')).rows[0]?.album_name).toBe('The very last folder');

  // Find one folder among 5,000 by name.
  await page.getByPlaceholder('Find a folder').fill('Set 2345');
  await expect(picked.getByTestId('folder-group')).toHaveCount(0);
  await expect(picked.getByTestId('folder-row')).toHaveCount(1);
  await expect(picked.getByRole('textbox', { name: 'Album name for Group 23 / Set 2345', exact: true })).toHaveValue('Group 23 – Set 2345');
  await page.getByPlaceholder('Find a folder').fill('');

  // One choice on the picked folder reaches all 5,000 rows, in one request.
  const everything = picked.getByRole('group', { name: `For every folder in ${root}` });
  await everything.getByRole('textbox', { name: `Tags for every folder in ${root}`, exact: true }).click();
  const tagged = Date.now();
  await everything.getByRole('button', { name: 'field dimension', exact: true }).click();
  await expect.poll(async () => (await fixtures.sql.query("select count(*)::int as n from public.migration_folders f join public.migration_sources s on s.id=f.source_id where s.batch_id=$1 and f.tags='{\"field dimension\"}'", [batch])).rows[0].n, { timeout: 30_000 }).toBe(5000);
  const tagMs = Date.now() - tagged;
  // The page is still responsive afterwards: the earlier edit is intact and another group opens.
  expect((await stored('Group 49/Set 4999')).rows[0]).toEqual({ album_name: 'The very last folder', tags: ['field dimension'] });
  await picked.getByTestId('folder-group').first().getByRole('button', { expanded: false }).click();
  await expect(picked.getByTestId('folder-group').first().getByTestId('folder-row')).toHaveCount(100);
  await expect(page.getByRole('button', { name: 'Start import', exact: true })).toBeEnabled();
  console.info('IMPORT_REVIEW_5000_BENCHMARK', JSON.stringify({ rows: 5000, open_last_group_ms: openMs, tag_every_folder_ms: tagMs }));
  expect(openMs).toBeLessThan(5000); expect(tagMs).toBeLessThan(30_000);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
});

test('AC-20: /migrate opens with no hand-off, and creates nothing until a folder is chosen', async ({ page, context }) => {
  await signIn(context, [{ label: `Unused ${run}`, files: [photo('unused.png')] }]);
  const before = (await fixtures.sql.query('select count(*)::int as n from public.migration_batches')).rows[0].n as number;
  await page.goto('/migrate');
  await expect(page.getByRole('heading', { level: 1, name: 'Import folders' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeEnabled();
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  expect((await fixtures.sql.query('select count(*)::int as n from public.migration_batches')).rows[0].n).toBe(before);
  // Nothing internal on the screen (baseline finding S7).
  const text = await page.locator('main').innerText();
  for (const word of ['Foreground', 'migration', 'batch', 'inventory', 'source', 'draft', 'sidecar']) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`AC-20: a browser that cannot open folders is told so instead of failing, at ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport);
    await signIn(context, null);
    // Phones, Safari, and Firefox have no folder picker. Chromium does, so take it away.
    await context.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
      delete (Window.prototype as unknown as Record<string, unknown>).showDirectoryPicker;
    });
    await page.goto('/migrate');
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).showDirectoryPicker)).toBe('undefined');
    const notice = page.getByTestId('folders-unavailable');
    await expect(notice).toContainText('Importing folders needs a computer');
    await expect(notice).toContainText('Chrome or Edge on a computer');
    await expect(page.getByRole('button', { name: /^Choose (another )?folder$/ })).toHaveCount(0);
    // It is an explanation, not an error, and the page still offers what this device CAN do.
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add photos', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Select photos', { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('loose-rule')).toHaveText('Pick a project, an album, or both.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`no-folder-picker-${viewport.name}.png`), fullPage: true,
      style: 'div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }' });
  });
}
