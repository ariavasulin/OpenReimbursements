import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories, type DirectoryFixture } from './directory-fixture';

// plan dws-photos-client-feedback, Phase W2-C / AC-21: a second format of a shot already in the
// project (IMG_1234.CR2 beside IMG_1234.JPG) is held in the upload tray until Keep, and the folder
// import leaves it out unless "Keep other formats" is on.
//
// Every spec file shares one database, and a photo's identity is its bytes. The directory fixture
// derives bytes from (size, seed), so this file keeps to sizes 7000-7999, which no other file uses.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 8);
const job = randomUUID();
const projectLabel = `TWIN-${run} · Format twins`;
/** The directory fixture stamps every file with this modification time: their capture time here. */
const FIXTURE_MTIME = 1_700_000_000_000;

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [job, `TWIN-${run}`, 'Format twins']);
});
test.afterAll(async () => { await fixtures?.close(); });

async function signIn(context: BrowserContext, directories?: DirectoryFixture[]) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  if (directories) await installDirectories(context, directories, png.toString('base64'));
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true,
    style: 'main { height: auto !important; overflow: visible !important; } div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
const inProject = async (names: string[]) => (await fixtures.sql.query(
  'select original_name from public.photos where job_id=$1 and original_name = any($2) and deleted_at is null order by original_name', [job, names],
)).rows.map(row => row.original_name as string);

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`AC-21: the tray holds another format of a photo in the project until Keep, on ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport); await signIn(context);
    const base = `IMG_${viewport.name}_${run}`;
    const shot = Date.parse('2031-04-05T06:07:08.000Z');
    // The JPEG is already in the project, captured at `shot`.
    await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,mime_type,content_sha256,captured_at)
      values(gen_random_uuid(),$1,$2,'image',$3,'originals/twin/'||gen_random_uuid(),'image/jpeg',$4,$5)`,
    [job, fixtures.employeeB.id, `${base}.JPG`, createHash('sha256').update(`${base}-jpg`).digest('hex'), new Date(shot).toISOString()]);
    await page.goto(`/photos/${job}`);
    // A RAW file with no browser type, taken the same second (its file time: RAW metadata is never decoded).
    await page.locator('input[type=file][multiple]').first().evaluate((input: HTMLInputElement, { name, lastModified, seed }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(4096).fill(seed)], name, { lastModified }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: `${base}.CR2`, lastModified: shot, seed: viewport.width % 251 });
    await page.getByRole('button', { name: 'Upload 1 file', exact: true }).click();
    await page.getByRole('button', { name: /1 upload needs attention/ }).click();
    await expect(page.getByText(`Looks like another format of ${base}.JPG`, { exact: true })).toBeVisible();
    await expect(page.getByText('Not uploaded', { exact: true })).toBeVisible();
    expect(await inProject([`${base}.JPG`, `${base}.CR2`])).toEqual([`${base}.JPG`]);
    await capture(page, info, `${viewport.name}-tray-format-twin`);

    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(page.getByRole('button', { name: /^1 uploaded$/ })).toBeVisible({ timeout: 60_000 });
    expect(await inProject([`${base}.JPG`, `${base}.CR2`])).toEqual([`${base}.CR2`, `${base}.JPG`]);
    const kept = (await fixtures.sql.query('select kind,mime_type from public.photos where original_name=$1', [`${base}.CR2`])).rows[0];
    expect(kept).toEqual({ kind: 'image', mime_type: 'image/x-canon-cr2' });
  });
}

async function importFolder(page: Page, root: string, keepFormats: boolean) {
  await page.goto('/migrate');
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  const picked = page.getByTestId('migration-source').filter({ hasText: root });
  await expect(picked.getByTestId('source-counts')).toContainText(/2 photos/, { timeout: 120_000 });
  await picked.getByRole('button', { name: `Project for ${root}: No project`, exact: true }).click();
  await picked.getByLabel('Find a project by number or name').fill(`TWIN-${run}`);
  await picked.getByRole('option', { name: projectLabel, exact: true }).getByRole('button').click();
  await expect(picked.getByRole('button', { name: `Project for ${root}: ${projectLabel}`, exact: true })).toBeVisible();
  const keep = page.getByRole('switch', { name: /Keep other formats/ });
  await expect(keep).toHaveAttribute('aria-checked', 'false');
  if (keepFormats) { await keep.click(); await expect(keep).toHaveAttribute('aria-checked', 'true'); }
  await page.getByRole('button', { name: 'Start import', exact: true }).click();
  await expect(page.getByTestId('batch-status')).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
}

test('AC-21: the folder import leaves another format out, and "Keep other formats" imports both', async ({ page, context, browser }, info) => {
  const off = `Twins off ${run}`, on = `Twins on ${run}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(context, [{ label: off, files: [{ name: `IMG_OFF_${run}.CR2`, bytes: 7000, seed: 71 }, { name: `IMG_OFF_${run}.JPG`, bytes: 7001, seed: 71 }] }]);
  await importFolder(page, off, false);
  const offNames = [`IMG_OFF_${run}.CR2`, `IMG_OFF_${run}.JPG`];
  const imported = await inProject(offNames);
  expect(imported).toHaveLength(1);
  const [leftOut] = offNames.filter(name => !imported.includes(name));
  await expect(page.getByTestId('migration-item').filter({ hasText: leftOut }))
    .toContainText(`Left out: looks like another format of ${imported[0]}`);
  await capture(page, info, 'import-format-twin-left-out');

  // The picker fixture is set per browser context.
  const second = await browser.newContext({ baseURL: process.env.DWS_BROWSER_BASE_URL, viewport: { width: 390, height: 844 } });
  await signIn(second, [{ label: on, files: [{ name: `IMG_ON_${run}.CR2`, bytes: 7002, seed: 72 }, { name: `IMG_ON_${run}.JPG`, bytes: 7003, seed: 72 }] }]);
  const phone = await second.newPage();
  await importFolder(phone, on, true);
  expect(await inProject([`IMG_ON_${run}.CR2`, `IMG_ON_${run}.JPG`])).toEqual([`IMG_ON_${run}.CR2`, `IMG_ON_${run}.JPG`]);
  expect(Date.parse((await fixtures.sql.query('select captured_at from public.photos where original_name=$1', [`IMG_ON_${run}.JPG`])).rows[0].captured_at)).toBe(FIXTURE_MTIME);
  await capture(phone, info, 'import-keep-other-formats');
  await second.close();
});
