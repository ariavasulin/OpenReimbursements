import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-D:
//   AC-15  40 selected photos download as one zip: every entry named, no two alike, the bytes adding up
//          to the photos' original_bytes; a phone's confirm says large downloads work best on a computer;
//          above 2 GB the confirm warns before any original is fetched.
// Every test owns its rows; afterAll removes them.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 6);
const project = randomUUID();
const madePhotos: string[] = [];

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [project, `ZP-${run}`, `Zip ${run}`]);
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[]) or original_name like $2', [madePhotos, `zipfill-${run}-%`]);
  await fixtures.sql.query('delete from public.jobs where id=$1', [project]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
/** A real image in Storage plus its row, hand-named `displayName` (several may share one). */
async function seed(displayName: string, originalName: string, capturedAt: string) {
  const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16 + madePhotos.length)]);
  const path = `originals/${fixtures.employeeA.id}/${id}/${originalName}`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,display_name,name_source,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at)
    values($1,$2,$3,'image',$4,$5,'manual',$6,$7,'image/png',$8,$6,$9)`,
    [id, project, fixtures.employeeA.id, originalName, displayName, path, bytes.length, createHash('sha256').update(bytes).digest('hex'), capturedAt]);
  madePhotos.push(id);
  return id;
}

/** The zip's central directory: each entry's name, stored size, and compression method (0 = stored). */
function zipEntries(zip: Buffer) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: { name: string; size: number; method: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      method: zip.readUInt16LE(at + 10),
      size: zip.readUInt32LE(at + 24),
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

const tile = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}`) }).last();
const tick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).last();
const bar = (page: Page) => page.getByRole('region', { name: 'Selected photos' });
/** Requests for an original: none may start before the confirm. */
const originalRequests = (page: Page) => {
  const seen: string[] = [];
  page.on('request', request => { if (request.url().includes('/storage/v1/object/public/photos/originals/')) seen.push(request.url()); });
  return seen;
};

test('AC-15: 40 selected photos download as one zip with 40 uniquely named entries and the expected total size', async ({ page, context }) => {
  test.setTimeout(300_000);
  await authenticate(context);
  // No save dialog: the zip arrives as a blob download, which Playwright captures.
  await context.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  // 20 share one name (the ` (2)` … ` (20)` path) and 20 have their own.
  const shared = `Zip same ${run}`;
  const ids: string[] = [];
  for (let i = 0; i < 20; i += 1) ids.push(await seed(shared, `same-${i}.png`, `2031-03-0${1 + (i % 3)}T18:${String(i).padStart(2, '0')}:00Z`));
  for (let i = 0; i < 20; i += 1) ids.push(await seed(`zip-${i}-${run}`, `own-${i}.png`, `2031-03-04T18:${String(i).padStart(2, '0')}:00Z`));
  const expectedBytes = (await fixtures.sql.query('select sum(original_bytes)::int as n from public.photos where id=any($1::uuid[])', [ids])).rows[0].n as number;
  const fetched = originalRequests(page);

  await page.goto(`/photos/${project}`);
  const first = `zip-19-${run}`;
  await expect(tile(page, first)).toBeVisible();
  await tile(page, first).hover(); await tick(page, first).click();
  await expect(page.getByTestId('selection-select-all')).toHaveText('Select all 40');
  await page.getByTestId('selection-select-all').click();
  await expect(page.getByTestId('selection-count')).toHaveText('40 selected');

  await bar(page).getByRole('button', { name: 'Download', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Download 40 photos' });
  await expect(dialog.getByTestId('download-total')).toHaveText(/^40 photos in one zip file, \d/);
  await expect(dialog.getByTestId('download-size-warning')).toHaveCount(0);
  await expect(dialog.getByTestId('download-phone-note')).toHaveCount(0);
  expect(fetched).toEqual([]);

  const downloading = page.waitForEvent('download', { timeout: 120_000 });
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^Photos \d{4}-\d{2}-\d{2}\.zip$/);
  const entries = zipEntries(await readFile((await download.path())!));

  expect(entries).toHaveLength(40);
  expect(new Set(entries.map(entry => entry.name.toLowerCase())).size).toBe(40);
  expect(entries.every(entry => entry.method === 0)).toBe(true);
  expect(entries.reduce((sum, entry) => sum + entry.size, 0)).toBe(expectedBytes);
  const expectedNames = [
    `${shared}.png`, ...Array.from({ length: 19 }, (_, i) => `${shared} (${i + 2}).png`),
    ...Array.from({ length: 20 }, (_, i) => `zip-${i}-${run}.png`),
  ];
  expect(entries.map(entry => entry.name).sort()).toEqual(expectedNames.sort());
  await expect(page.getByText('Downloaded 40 photos', { exact: true })).toBeVisible();
  await expect(page.getByTestId('selection-count')).toHaveCount(0);
});

test('AC-15: on a phone the confirm says large downloads work best on a computer', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: process.env.DWS_BROWSER_BASE_URL });
  try {
    await authenticate(context);
    const name = `zip-phone-${run}`;
    await seed(name, 'phone.png', '2031-02-01T18:00:00Z');
    const page = await context.newPage();
    await page.goto(`/photos/${project}`);
    // Press and hold selects on a phone.
    await tile(page, name).scrollIntoViewIfNeeded();
    const box = (await tile(page, name).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    await expect(page.getByTestId('selection-count')).toHaveText('1 selected');

    await bar(page).getByRole('button', { name: 'Download', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Download 1 photo' });
    await expect(sheet.getByTestId('download-phone-note')).toHaveText('Large downloads work best on a computer.');
    await expect(sheet.getByTestId('download-total')).toHaveText(/^1 photo in one zip file, /);
    await expect(sheet.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  } finally { await context.close(); }
});

test('AC-15: above 2 GB the confirm warns before any original is fetched, sizes found for photos not loaded yet', async ({ page, context }) => {
  test.setTimeout(240_000);
  await authenticate(context);
  // 300 rows of 10 MB each (sizes stubbed, no files): 3 GB. A page loads 100, so the confirm looks up the rest.
  const big = randomUUID();
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [big, `ZB-${run}`, `Zip big ${run}`]);
  try {
    await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,display_name,name_source,original_path,original_bytes,mime_type,captured_at)
      select gen_random_uuid(),$1,$2,'file','zipfill-${run}-'||n||'.pdf','zipfill-${run}-'||n||'.pdf','manual','originals/zipfill-${run}/'||gen_random_uuid(),10000000,'application/pdf','2031-01-01T18:00:00Z'::timestamptz
      from generate_series(1,300) n`, [big, fixtures.employeeA.id]);
    const fetched = originalRequests(page);
    const lookups: string[] = [];
    page.on('request', request => { if (/\/api\/photos\?.*limit=200/.test(request.url())) lookups.push(request.url()); });

    await page.goto(`/photos/${big}`);
    const ticks = page.getByRole('checkbox', { name: new RegExp(`^Select zipfill-${run}-`) });
    await expect(ticks.first()).toBeAttached();
    expect(await ticks.count()).toBeLessThan(300);
    await ticks.first().click();
    await page.getByTestId('selection-select-all').click();
    await expect(page.getByTestId('selection-count')).toHaveText('300 selected');

    await bar(page).getByRole('button', { name: 'Download', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Download 300 photos' });
    await expect(dialog.getByTestId('download-total')).toHaveText('300 photos in one zip file, 2.8 GB.');
    await expect(dialog.getByTestId('download-size-warning')).toContainText('over 2 GB');
    await expect(dialog.getByRole('button', { name: 'Download anyway', exact: true })).toBeEnabled();
    expect(lookups.length).toBeGreaterThan(0);
    expect(fetched).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(fetched).toEqual([]);
  } finally {
    await fixtures.sql.query('delete from public.photos where original_name like $1', [`zipfill-${run}-%`]);
    await fixtures.sql.query('delete from public.jobs where id=$1', [big]);
  }
});
