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
// The raw file carries its own tag, so Tag + Uploader can combine to an empty view.
const rawTag = `raw ${run}`;
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
  // A long name, so an active Project filter has a label that must truncate.
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [project, `TB-${run}`, `Harborview Tower Level 12 Office Fit-Out – Reception, Boardroom and Partitions ${run}`]);
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
    [project, fixtures.employeeB.id, `IMG_${run}.CR2`, [rawTag]]);
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

test('at 320 px a long active Project filter truncates instead of pushing the page sideways', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 640 }); await authenticate(context);
  await page.goto('/photos');
  await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Filter', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Filter' });
  const projectSelect = sheet.getByRole('combobox', { name: 'Project', exact: true });
  await projectSelect.selectOption(project);
  await sheet.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]project=${project}`));
  const projectChip = page.getByRole('group', { name: 'Active filters' }).getByRole('button', { name: new RegExp(`^Remove filter .*${run}$`) });
  await expect(projectChip).toBeVisible();
  const box = (await projectChip.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expectNoSidewaysScroll(page, 'Photos at 320 with a long Project filter');
});

test('an empty filtered view is not shown as the next filter\'s answer while that filter loads', async ({ page, context }) => {
  await authenticate(context);
  await page.goto(`/photos/${project}`);
  const filters = page.getByRole('group', { name: 'Filters' });
  // Luis's only photo here is the raw file, which lacks `tag`.
  await filters.getByRole('button', { name: 'Filter by tags', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: tag, exact: true }).click();
  await page.keyboard.press('Escape');
  await filters.getByRole('button', { name: 'Filter by uploader', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Luis Ortega', exact: true }).click();
  const noMatch = page.getByText('No photos match', { exact: true });
  await expect(noMatch).toBeVisible();
  // The next uploader's answer is held: the empty view must not stand in for it.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/photos', async route => { await held; await route.continue(); });
  await filters.getByRole('button', { name: 'Uploader: Luis Ortega', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Yana Ronin', exact: true }).click();
  await expect(filters.getByRole('button', { name: 'Uploader: Yana Ronin', exact: true })).toBeVisible();
  await expect(noMatch).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^March [12], 2032$/ })).toHaveCount(2);
  await expect(noMatch).toHaveCount(0);
});

test('at 390 px Filter, Group by, and Sort share one row; desktop shows the filters as chips in that row', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await authenticate(context);
  await page.goto('/photos');
  const filters = page.getByRole('group', { name: 'Filters' });
  const row = [filters.getByRole('button', { name: 'Filter', exact: true }), chip(page, 'Group by'), chip(page, 'Sort')];
  for (const control of row) await expect(control).toBeVisible();
  const boxes = await Promise.all(row.map(async control => (await control.boundingBox())!));
  for (const box of boxes) {
    expect(Math.abs(box.y - boxes[0].y)).toBeLessThan(1);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // The desktop chips are not drawn on a phone.
  await expect(filters.getByRole('button', { name: 'Filter by project', exact: true })).toHaveCount(0);
  await expectNoSidewaysScroll(page, 'Photos at 390');

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ['Filter by project', 'Filter by uploader', 'Filter by tags', 'Filter by file type', 'Filter by date']) {
    await expect(filters.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(filters.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);
  const desktop = await Promise.all([filters.getByRole('button', { name: 'Filter by project', exact: true }), chip(page, 'Sort')].map(async control => (await control.boundingBox())!));
  expect(Math.abs(desktop[0].y - desktop[1].y)).toBeLessThan(1);
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

/** Sets Tags, File type, and a one-day Date range the way each layout offers them. */
async function setThreeFilters(page: Page, layout: 'desktop' | 'phone') {
  if (layout === 'desktop') {
    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Filter by tags', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: tag, exact: true }).click();
    await page.keyboard.press('Escape');
    await filters.getByRole('button', { name: 'Filter by file type', exact: true }).click();
    await page.getByRole('menuitem', { name: 'PNG', exact: true }).click();
    await filters.getByRole('button', { name: 'Filter by date', exact: true }).click();
    const popover = page.getByRole('dialog', { name: 'Date' });
    await popover.getByRole('button', { name: 'Custom range', exact: true }).click();
    await popover.getByLabel('From', { exact: true }).fill('2032-03-01');
    await popover.getByLabel('To', { exact: true }).fill('2032-03-01');
    await popover.getByRole('button', { name: 'Show these dates', exact: true }).click();
  } else {
    await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Filter', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filter' });
    await sheet.getByRole('group', { name: 'Tags' }).getByRole('button', { name: tag, exact: true }).click();
    await sheet.getByRole('group', { name: 'File type' }).getByRole('button', { name: 'PNG', exact: true }).click();
    await sheet.getByRole('button', { name: 'Custom range', exact: true }).click();
    await sheet.getByLabel('From', { exact: true }).fill('2032-03-01');
    await sheet.getByLabel('To', { exact: true }).fill('2032-03-01');
    await sheet.getByRole('button', { name: 'Show these dates', exact: true }).click();
    await sheet.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Filter, 3 on', exact: true })).toBeVisible();
  }
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }] as const) {
  test(`client-feedback AC-10: three filters live in the URL, survive a reload, and Clear empties it on ${viewport.name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await page.goto(`/photos/${project}`);
    const days = page.getByRole('heading', { level: 2 }).filter({ hasText: /^March [123], 2032$/ });
    await expect(days).toHaveCount(3);
    await setThreeFilters(page, viewport.name);
    const active = page.getByRole('group', { name: 'Active filters' });
    const expectFiltered = async () => {
      for (const label of [tag, 'PNG', 'Mar 1, 2032']) await expect(active.getByRole('button', { name: `Remove filter ${label}`, exact: true })).toBeVisible();
      await expect(days).toHaveText(['March 1, 2032']);
    };
    await expectFiltered();
    const url = new URL(page.url());
    expect(url.searchParams.get('tags')).toBe(tag);
    expect(url.searchParams.get('type')).toBe('png');
    // The day is sent as the instants of its local start and end.
    expect(new Date(url.searchParams.get('from')!).getTime()).toBe(new Date(2032, 2, 1).getTime());
    expect(new Date(url.searchParams.get('to')!).getTime()).toBe(new Date(2032, 2, 2).getTime() - 1);

    await page.reload();
    await expectFiltered();

    // One × takes one filter off.
    await active.getByRole('button', { name: 'Remove filter PNG', exact: true }).click();
    await expect(page).not.toHaveURL(/[?&]type=/);
    await active.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/photos/${project}$`));
    await expect(active).toHaveCount(0);
    await expect(days).toHaveCount(3);

    // A pasted link that matches nothing offers Clear filters, which empties the URL too.
    await page.goto(`/photos/${project}?tags=${encodeURIComponent(tag)}&type=raw`);
    await expect(page.getByText('No photos match', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/photos/${project}$`));
    await expect(days).toHaveCount(3);
    await expectNoSidewaysScroll(page, `project page on ${viewport.name}`);
  });
}

test('sort and grouping live in the URL too, and a search keeps its words when filters clear', async ({ page, context }) => {
  await authenticate(context);
  await page.goto(`/photos/search?q=${encodeURIComponent(tag)}`);
  await choose(page, 'Group by', 'File type');
  await choose(page, 'Sort', 'Oldest');
  await expect(page).toHaveURL(/[?&]group=type/);
  await expect(page).toHaveURL(/[?&]sort=asc/);
  await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Filter by project', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(run) }).click();
  await page.reload();
  await expect(chip(page, 'Group by')).toHaveAccessibleName('Group by: File type');
  await expect(chip(page, 'Sort')).toHaveAccessibleName('Sort: Oldest');
  await expect(page.getByRole('group', { name: 'Active filters' }).getByRole('button', { name: new RegExp(`^Remove filter .*${run}$`) })).toBeVisible();
  await page.getByRole('group', { name: 'Active filters' }).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]project=/);
  expect(new URL(page.url()).searchParams.get('q')).toBe(tag);
  // Clear takes filters off, not the chosen layout.
  await expect(chip(page, 'Sort')).toHaveAccessibleName('Sort: Oldest');
});
