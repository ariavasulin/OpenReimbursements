import { test, expect, devices, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createFixtures } from '../../integration/fixtures';

// plans/active/dws-photos-client-feedback/plan.md, Phase W2-B — the photo viewer:
//   AC-18  photos edge to edge; a tap hides every control and the next brings them back;
//          arrow keys and Escape work either way
//   AC-19  desktop Details starts hidden, toggles with the "i" button, and is remembered for the
//          tab; Fullscreen on desktop Chromium, not under iPhone emulation
//   AC-20  Play on an album of three photos and a video plays the three, 4 s each, looping,
//          never the video, controls hidden until a tap, which pauses it
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let wide: Buffer;
const run = randomUUID().slice(0, 6);
const project = randomUUID();
const madePhotos: string[] = [];
const madeAlbums: string[] = [];

const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }] as const;

test.beforeAll(async () => {
  fixtures = await createFixtures();
  // Three times wider than tall and wider than either screen: it fills the width of both.
  wide = await sharp({ create: { width: 1800, height: 600, channels: 3, background: { r: 38, g: 128, b: 252 } } }).png().toBuffer();
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [project, `VW-${run}`, `Viewer ${run}`]);
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.albums where id=any($1::uuid[])', [madeAlbums]);
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[])', [madePhotos]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
/**
 * A wide image in Storage plus its row; `video` makes the row a video whose poster is that image
 * (the original need not exist: the slideshow must never get as far as playing it).
 */
async function seed(name: string, capturedAt: string, options: { video?: boolean; jobId?: string | null } = {}) {
  const id = randomUUID(); const bytes = Buffer.concat([wide, randomBytes(16)]);
  const uploader = fixtures.employeeA.id;
  const imagePath = `originals/${uploader}/${id}/${name}.png`;
  expect((await fixtures.admin.storage.from('photos').upload(imagePath, bytes, { contentType: 'image/png' })).error).toBeNull();
  const original = options.video ? `originals/${uploader}/${id}/${name}.mp4` : imagePath;
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,display_name,name_source,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at)
    values($1,$2,$3,$4,$5,$5,'manual',$6,$7,$8,$9,$10,$11)`,
    [id, options.jobId === undefined ? project : options.jobId, uploader, options.video ? 'video' : 'image', name, original, bytes.length,
      options.video ? 'video/mp4' : 'image/png', createHash('sha256').update(bytes).digest('hex'), imagePath, capturedAt]);
  madePhotos.push(id);
  return { id, path: imagePath };
}
async function album(name: string, photoIds: string[]) {
  const id = randomUUID();
  await fixtures.sql.query('insert into public.albums(id,name,created_by) values($1,$2,$3)', [id, name, fixtures.employeeA.id]);
  for (const photo of photoIds) await fixtures.sql.query('insert into public.album_photos(album_id,photo_id,added_by) values($1,$2,$3)', [id, photo, fixtures.employeeA.id]);
  madeAlbums.push(id);
  return id;
}

// Newest first, as the grids sort by default: first, (the video,) second, third.
const photos = { first: '', second: '', third: '' };
const paths = { first: '', second: '', third: '', video: '' };
let videoId = '';
let albumId = '';
test.beforeAll(async () => {
  const first = await seed(`view-first-${run}`, '2026-03-04T12:00:03Z');
  // The video has no project: the project's grid holds the three photos only, the album all four.
  const video = await seed(`view-video-${run}`, '2026-03-04T12:00:02Z', { video: true, jobId: null });
  const second = await seed(`view-second-${run}`, '2026-03-04T12:00:01Z');
  const third = await seed(`view-third-${run}`, '2026-03-04T12:00:00Z');
  Object.assign(photos, { first: first.id, second: second.id, third: third.id });
  Object.assign(paths, { first: first.path, second: second.path, third: third.path, video: video.path });
  videoId = video.id;
  albumId = await album(`Slideshow ${run}`, [first.id, video.id, second.id, third.id]);
});

const toolbar = (page: Page) => page.locator('.yarl__toolbar');
const counter = (page: Page) => page.locator('.yarl__counter');
const shown = (page: Page) => page.locator('.yarl__slide_current .yarl__slide_image');
const detailsPanel = (page: Page) => page.getByRole('complementary', { name: 'Details' });
const position = (at: number, of: number) => new RegExp(`^\\s*${at}\\s*/\\s*${of}\\s*$`);
/** Which seeded photo the viewer is showing, by the end of its image address. */
async function current(page: Page) {
  const src = (await shown(page).getAttribute('src')) ?? '';
  return (Object.entries(paths).find(([, path]) => src.endsWith(path)) ?? ['other'])[0];
}

for (const viewport of VIEWPORTS) {
  const v = viewport.name;

  test(`AC-18: the photo fills the screen, a tap hides every control and the next brings them back, keys work either way, on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await page.goto(`/photos/${project}?photo=${photos.first}`);
    await expect(shown(page)).toBeVisible();
    await expect(counter(page)).toHaveText(position(1, 3));
    // Edge to edge: the wide photo spans the full width, with no padding around it.
    await expect.poll(async () => {
      const box = await shown(page).boundingBox();
      return box ? [Math.abs(Math.round(box.x)), Math.round(box.x + box.width)] : null;
    }).toEqual([0, viewport.width]);
    if (v === 'desktop') {
      await page.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(detailsPanel(page)).toBeVisible();
    }

    // One tap hides the toolbar, the counter, the arrows, and the Details panel.
    await shown(page).click();
    await expect(toolbar(page)).toBeHidden();
    await expect(counter(page)).toBeHidden();
    await expect(page.locator('.yarl__navigation_next')).toBeHidden();
    if (v === 'desktop') {
      await expect(detailsPanel(page)).toHaveCount(0);
      await expect(page.locator('.yarl__thumbnails_container')).toBeHidden();
    }
    // The arrow keys still move while the controls are hidden, and stay hidden.
    await page.keyboard.press('ArrowRight');
    await expect(counter(page)).toHaveText(position(2, 3));
    await expect.poll(() => current(page)).toBe('second');
    await expect(toolbar(page)).toBeHidden();

    // The next tap brings everything back, Details panel included.
    await shown(page).click();
    await expect(toolbar(page)).toBeVisible();
    await expect(counter(page)).toBeVisible();
    if (v === 'desktop') await expect(detailsPanel(page)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(counter(page)).toHaveText(position(3, 3));

    // Escape closes with the controls showing ...
    await page.keyboard.press('Escape');
    await expect(shown(page)).toHaveCount(0);
    // ... and with them hidden.
    await page.goto(`/photos/${project}?photo=${photos.first}`);
    await expect(toolbar(page)).toBeVisible();
    await shown(page).click();
    await expect(toolbar(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(shown(page)).toHaveCount(0);
    // The project page offers Play.
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  });

  test(`AC-20: Play on an album plays its three photos at 4 s each and never the video, controls hidden until a tap, on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await page.goto(`/photos/albums/${albumId}`);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(shown(page)).toBeVisible();
    // The stills only: three, not four, starting with the first, controls hidden.
    await expect(counter(page)).toHaveText(position(1, 3));
    expect(await current(page)).toBe('first');
    await expect(toolbar(page)).toBeHidden();

    const seen: string[] = ['first'];
    let previous = Date.now();
    for (const [at, name] of [[2, 'second'], [3, 'third'], [1, 'first']] as const) {
      await expect(counter(page)).toHaveText(position(at, 3), { timeout: 10_000 });
      const elapsed = Date.now() - previous; previous = Date.now();
      expect(elapsed, `photo ${at} arrived after ${elapsed} ms`).toBeGreaterThan(2_500);
      expect(elapsed, `photo ${at} arrived after ${elapsed} ms`).toBeLessThan(7_500);
      await expect.poll(() => current(page)).toBe(name);
      seen.push(name);
      await expect(page.locator('.yarl__slide_current video')).toHaveCount(0);
      await expect(toolbar(page)).toBeHidden();
    }
    expect(seen).toEqual(['first', 'second', 'third', 'first']);

    // A tap pauses it and shows the controls. Paused, the viewer is back among everything on the
    // page, the video included, and it stays put on the same photo.
    await shown(page).click();
    await expect(toolbar(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(counter(page)).toHaveText(position(1, 4));
    await page.waitForTimeout(5_000);
    await expect(counter(page)).toHaveText(position(1, 4));
    expect(await current(page)).toBe('first');
    await page.keyboard.press('ArrowRight');
    await expect(counter(page)).toHaveText(position(2, 4));
    await page.keyboard.press('Escape');
    await expect(shown(page)).toHaveCount(0);
  });

  test(`AC-20: Play inside the viewer starts from the next photo when a video is open, on ${v}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await page.goto(`/photos/albums/${albumId}?photo=${videoId}`);
    await expect(counter(page)).toHaveText(position(2, 4));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(counter(page)).toHaveText(position(2, 3));
    await expect.poll(() => current(page)).toBe('second');
    await expect(toolbar(page)).toBeHidden();
    await expect(counter(page)).toHaveText(position(3, 3), { timeout: 10_000 });
  });
}

test('AC-19: desktop Details starts hidden, the "i" button shows it, and the choice holds across photos and visits', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await authenticate(context);
  await page.goto(`/photos/${project}?photo=${photos.first}`);
  await expect(shown(page)).toBeVisible();
  const details = page.getByRole('button', { name: 'Details', exact: true });
  await expect(details).toHaveAttribute('aria-pressed', 'false');
  await expect(detailsPanel(page)).toHaveCount(0);
  // Fullscreen is offered on desktop Chromium.
  await expect(page.getByRole('button', { name: 'Enter Fullscreen', exact: true })).toBeVisible();

  await details.click();
  await expect(details).toHaveAttribute('aria-pressed', 'true');
  await expect(detailsPanel(page)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toHaveText(position(2, 3));
  await expect(detailsPanel(page)).toBeVisible();
  // Closed and opened again, and after a reload: still on for this tab.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: new RegExp(`^view-third-${run}`) }).last().click();
  await expect(detailsPanel(page)).toBeVisible();
  await page.goto(`/photos/${project}?photo=${photos.first}`);
  await expect(detailsPanel(page)).toBeVisible();
  // Off again, and that is remembered too.
  await details.click();
  await expect(detailsPanel(page)).toHaveCount(0);
  await page.reload();
  await expect(shown(page)).toBeVisible();
  await expect(detailsPanel(page)).toHaveCount(0);
});

test('AC-19: no Fullscreen button under iPhone emulation', async ({ browser }) => {
  // Chromium with the iPhone's screen, touch, and user agent (the suite runs Chromium only).
  const context = await browser.newContext({ ...devices['iPhone 15'], baseURL: process.env.DWS_BROWSER_BASE_URL });
  try {
    await authenticate(context);
    const page = await context.newPage();
    await page.goto(`/photos/${project}?photo=${photos.first}`);
    await expect(shown(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveCount(0);
  } finally { await context.close(); }
});
