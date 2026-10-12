import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-E — Album Arrange:
//   AC-16  desktop: drag the third photo to the front with the mouse, Done, reload → it is first,
//          Sort reads Custom, and the order is saved in the database
//   AC-17  phone (iPhone 15 emulation): press and hold the third photo, drag it to the front,
//          Done, reload → it is first
// Every test owns its album and photos; afterAll removes them.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 6);
const madePhotos: string[] = [];
const madeAlbums: string[] = [];

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true');
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
  await fixtures.sql.query('delete from public.albums where id=any($1::uuid[])', [madeAlbums]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
/** A real image in Storage plus its row, named by hand so its tile can be found by name. */
async function seed(name: string, capturedAt: string) {
  const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16)]);
  const uploader = fixtures.employeeA.id;
  const path = `originals/${uploader}/${id}/${name}`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,display_name,name_source,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at)
    values($1,null,$2,'image',$3,$3,'manual',$4,$5,'image/png',$6,$4,$7)`,
    [id, uploader, name, path, bytes.length, createHash('sha256').update(bytes).digest('hex'), capturedAt]);
  madePhotos.push(id);
  return id;
}
/**
 * An album of four photos, captured a minute apart, so the page starts newest first:
 * `<label>-4`, `-3`, `-2`, `-1`. The third tile is `-2`.
 */
async function albumOfFour(label: string) {
  const id = randomUUID();
  await fixtures.sql.query('insert into public.albums(id,name,created_by) values($1,$2,$3)', [id, `Arrange ${label} ${run}`, fixtures.employeeA.id]);
  madeAlbums.push(id);
  const start = Date.UTC(2030, 3, 1, 12);
  const names: string[] = [];
  for (let n = 1; n <= 4; n++) {
    const name = `${label}-${run}-${n}.png`;
    const photo = await seed(name, new Date(start + n * 60_000).toISOString());
    await fixtures.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [id, photo, fixtures.employeeA.id]);
    names.push(name);
  }
  return { id, names };
}
/** The photo names in the album grid, top to bottom. */
const gridNames = (page: Page) => page.locator('main img[alt]').evaluateAll(images => images.map(image => image.getAttribute('alt')));
/** dnd-kit swallows any click in the 50 ms after a drop (its document click guard); a person cannot press Done that fast, so let it pass. */
const settleDrop = (page: Page) => page.waitForTimeout(100);
const arrangeTile = (page: Page, place: number) => page.getByRole('button', { name: new RegExp(`^${place}\\. `) });
async function savedOrder(albumId: string) {
  const { rows } = await fixtures.sql.query(`select p.display_name from public.album_photos ap join public.photos p on p.id=ap.photo_id
    where ap.album_id=$1 order by ap.position`, [albumId]);
  return rows.map(row => row.display_name as string);
}

test('AC-16: on desktop, dragging the third photo to the front and pressing Done keeps it first after a reload', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: process.env.DWS_BROWSER_BASE_URL });
  try {
    await authenticate(context);
    const page = await context.newPage();
    const { id, names } = await albumOfFour('desk');
    const [one, two, three, four] = names;
    await page.goto(`/photos/albums/${id}`);
    await expect.poll(() => gridNames(page)).toEqual([four, three, two, one]);
    // No order has been saved yet, so Sort offers only Newest and Oldest.
    await page.getByRole('button', { name: 'Sort: Newest' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Custom' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Arrange' }).click();
    await expect(arrangeTile(page, 3)).toHaveAccessibleName(`3. ${two}`);
    const from = (await arrangeTile(page, 3).boundingBox())!, to = (await arrangeTile(page, 1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, { steps: 2 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(arrangeTile(page, 1)).toHaveAccessibleName(`1. ${two}`);
    await settleDrop(page);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Order saved')).toBeVisible();

    await page.reload();
    await expect.poll(() => gridNames(page)).toEqual([two, four, three, one]);
    await expect(page.getByRole('button', { name: 'Sort: Custom' })).toBeVisible();
    expect(await savedOrder(id)).toEqual([two, four, three, one]);
  } finally { await context.close(); }
});

/** Press and hold at `from` for `holdMs`, slide to `to`, and lift: a real touch sequence through CDP. */
async function longPressDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs = 450) {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
  await page.waitForTimeout(holdMs);
  for (let step = 1; step <= 12; step++) {
    const x = from.x + ((to.x - from.x) * step) / 12, y = from.y + ((to.y - from.y) * step) / 12;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('AC-17: on a phone, press and hold then drag reorders, and the order holds after a reload', async ({ browser }) => {
  // Chromium with the iPhone's screen, touch, and user agent (the suite runs Chromium only).
  const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: process.env.DWS_BROWSER_BASE_URL });
  try {
    await authenticate(context);
    const page = await context.newPage();
    const { id, names } = await albumOfFour('phone');
    const [one, two, three, four] = names;
    await page.goto(`/photos/albums/${id}`);
    await expect.poll(() => gridNames(page)).toEqual([four, three, two, one]);

    const arrange = page.getByRole('button', { name: 'Arrange' });
    expect((await arrange.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await arrange.click();
    await expect(page.getByText('Press and hold a photo, then drag it.', { exact: false })).toBeVisible();
    for (const name of ['Cancel', 'Done']) {
      expect((await page.getByRole('button', { name, exact: true }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
    const from = (await arrangeTile(page, 3).boundingBox())!, to = (await arrangeTile(page, 1).boundingBox())!;
    await longPressDrag(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
    await expect(arrangeTile(page, 1)).toHaveAccessibleName(`1. ${two}`);
    await settleDrop(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText('Order saved')).toBeVisible();

    await page.reload();
    await expect.poll(() => gridNames(page)).toEqual([two, four, three, one]);
    // Nothing on the page is wider than the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});
