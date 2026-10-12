import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

// Every row made here is removed in afterAll: a later file needs a small library.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 6);
const project = randomUUID();
const tag = `toolbar ${run}`;
const madePhotos: string[] = [];
let namesBefore: { user_id: string; full_name: string | null }[] = [];

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true');
  // Named uploaders, so the Uploader filter chip shows (it hides with nothing to offer).
  namesBefore = (await fixtures.sql.query('select user_id,full_name from public.user_profiles where user_id=any($1::uuid[])', [[fixtures.employeeA.id, fixtures.employeeB.id]])).rows;
  await fixtures.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', ['Yana Ronin', fixtures.employeeA.id]);
  await fixtures.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', ['Luis Ortega', fixtures.employeeB.id]);
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [project, `TB-${run}`, `Toolbar ${run}`]);
  // Two images a day apart, and one camera raw file with no preview (a file tile).
  for (const [index, day] of ['2032-03-01', '2032-03-02'].entries()) {
    const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16)]);
    const path = `originals/${fixtures.employeeA.id}/${id}/toolbar-${index}.png`;
    expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
    await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at,tags)
      values($1,$2,$3,'image',$4,$5,$6,'image/png',$7,$5,$8,$9)`,
      [id, project, fixtures.employeeA.id, `toolbar-${index}-${run}.png`, path, bytes.length, createHash('sha256').update(bytes).digest('hex'), `${day}T18:00:00Z`, [tag]]);
    madePhotos.push(id);
  }
  const raw = await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,captured_at,tags)
    values(gen_random_uuid(),$1,$2,'image',$3,'originals/toolbar-'||gen_random_uuid(),10,'image/x-canon-cr2','2032-03-03T18:00:00Z',$4) returning id`,
    [project, fixtures.employeeB.id, `IMG_${run}.CR2`, [tag]]);
  madePhotos.push(raw.rows[0].id);
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
  await fixtures.sql.query('delete from public.jobs where id=$1', [project]);
  for (const row of namesBefore) await fixtures.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', [row.full_name, row.user_id]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
const view = (page: Page) => page.getByRole('group', { name: 'View' });
const chip = (page: Page, setting: 'Group by' | 'Sort') => view(page).getByRole('button', { name: new RegExp(`^${setting}: `) });
async function choose(page: Page, setting: 'Group by' | 'Sort', choice: string) {
  await chip(page, setting).click();
  await page.getByRole('menuitemradio', { name: choice, exact: true }).click();
  await expect(view(page).getByRole('button', { name: `${setting}: ${choice}`, exact: true })).toBeVisible();
}
/** The shell's scroller: the page must never be wider than it. */
async function expectNoSidewaysScroll(page: Page, label: string) {
  const scroller = page.locator('#photos-scrollport');
  const { scrollWidth, clientWidth } = await scroller.evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollWidth, label).toBeLessThanOrEqual(clientWidth);
}
/** Is the blue (#2680FC) focus ring drawn round the focused element? A ring of width 0 is not. */
const focusedRing = (page: Page) => page.evaluate(() => {
  const shadow = getComputedStyle(document.activeElement!).boxShadow;
  return [...shadow.matchAll(/rgb\(38, 128, 252\) 0px 0px 0px ([\d.]+)px/g)].some(match => Number(match[1]) > 0);
});

test('at 320 px no Group by or Sort choice makes the page scroll sideways', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 640 }); await authenticate(context);
  for (const path of [`/photos/${project}`, `/photos/search?q=${encodeURIComponent(tag)}`]) {
    await page.goto(path);
    await expect(chip(page, 'Sort')).toBeVisible();
    const modes = ['Date', 'Tag', 'Uploader', 'File type', ...(path.includes('search') ? ['Project'] : [])];
    for (const mode of modes) {
      await choose(page, 'Group by', mode);
      await expectNoSidewaysScroll(page, `${path} grouped by ${mode}`);
    }
    await choose(page, 'Sort', 'Oldest');
    await expectNoSidewaysScroll(page, `${path} sorted oldest first`);
    for (const setting of ['Group by', 'Sort'] as const) {
      const box = (await chip(page, setting).boundingBox())!;
      expect(box.height, setting).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, setting).toBeLessThanOrEqual(320);
    }
  }
});

test('at 390 px the four filter chips share one row and the View chips take the second', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await authenticate(context);
  await page.goto('/photos');
  const filters = page.getByRole('group', { name: 'Filters' });
  const filterChips = [
    filters.getByRole('button', { name: 'All', exact: true }),
    filters.getByRole('button', { name: 'Filter by project', exact: true }),
    filters.getByRole('button', { name: 'Filter by tag', exact: true }),
    filters.getByRole('button', { name: 'Filter by uploader', exact: true }),
  ];
  for (const filterChip of filterChips) await expect(filterChip).toBeVisible();
  const boxes = await Promise.all(filterChips.map(async filterChip => (await filterChip.boundingBox())!));
  for (const box of boxes) {
    expect(box.y).toBe(boxes[0].y);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const viewBoxes = await Promise.all((['Group by', 'Sort'] as const).map(async setting => (await chip(page, setting).boundingBox())!));
  expect(viewBoxes[0].y).toBe(viewBoxes[1].y);
  expect(viewBoxes[0].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
  await expectNoSidewaysScroll(page, 'Photos at 390');
});

test('a slow Sort keeps the toolbar and a dimmed grid on screen, and keyboard focus stays on the Sort chip', async ({ page, context }) => {
  await authenticate(context);
  await page.goto(`/photos/${project}`);
  await expect(chip(page, 'Sort')).toBeVisible();
  await chip(page, 'Group by').focus();
  await page.keyboard.press('Tab');
  await expect(chip(page, 'Sort')).toBeFocused();
  await expect(chip(page, 'Sort')).toHaveAccessibleName('Sort: Newest');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: 'Newest', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: 'Oldest', exact: true })).toBeFocused();
  // Every photo page now answers slowly.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/photos', async route => { await held; await route.continue(); });
  await page.keyboard.press('Enter');

  const grid = page.locator('[aria-busy="true"]');
  await expect(grid).toBeVisible();
  await expect(grid).toHaveClass(/opacity-60/);
  await expect(chip(page, 'Sort')).toHaveAccessibleName('Sort: Oldest');
  await expect(chip(page, 'Sort')).toBeFocused();
  // A keyboard pick keeps the focus ring.
  expect(await focusedRing(page)).toBe(true);

  release();
  await expect(grid).toHaveCount(0);
  await expect(chip(page, 'Sort')).toBeFocused();
  await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^March [123], 2032$/ }))
    .toHaveText(['March 1, 2032', 'March 2, 2032', 'March 3, 2032']);
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`a menu pick by pointer hands focus back to the chip without a ring on ${viewport.name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await page.goto(`/photos/${project}`);
    await choose(page, 'Group by', 'File type');
    await expect(chip(page, 'Group by')).toBeFocused();
    expect(await focusedRing(page)).toBe(false);
    // The File type groups name the raw file's tile, which has no picture.
    await expect(page.getByRole('heading', { name: 'RAW · 1 photo', exact: true })).toBeVisible();
    await chip(page, 'Group by').click();
    const menu = (await page.getByRole('menu', { name: 'Group by' }).boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(16);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 16);
    await page.keyboard.press('Escape');
    // Closed by keyboard: the ring is back.
    await expect(chip(page, 'Group by')).toBeFocused();
    expect(await focusedRing(page)).toBe(true);
  });
}
