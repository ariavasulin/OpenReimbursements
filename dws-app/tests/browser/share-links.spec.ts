import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories, type DirectoryFixture } from './directory-fixture';

// plans/active/photo-albums/plan.md, Phase 7: share links in a real browser.
// AC-21 (signed out: name, count, photos, view and download, and nothing private), AC-22 (off is a
// 404 at once), AC-23 (the pop-up states the limit), and the plan's one end-to-end scenario for G1-G6.
// Every spec file shares one database and a photo's identity is its bytes: this file keeps to
// fixture sizes 6000-6999, which no other file uses.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 8);
const UPLOADER = `Rosalind Uploader-${run}`;
let nextSize = 6000;
const photo = (name: string) => ({ name, bytes: nextSize++, seed: 6 });
const WHOLE_PAGE = 'main { height: auto !important; overflow: visible !important; } div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }';

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true,sharing_enabled=true');
  await fixtures.sql.query("insert into public.jobs(job_number,name) values('3612','Office North'),('4170','Office South') on conflict(job_number) do nothing");
  // The signed-in employee has a name, so "no uploader name on the public page" is a real check.
  await fixtures.sql.query('update public.user_profiles set full_name=$1 where user_id=$2', [UPLOADER, fixtures.employeeA.id]);
});
test.afterAll(async () => { await fixtures?.sql.query('update public.photo_release_state set sharing_enabled=false'); await fixtures?.close(); });

async function signIn(context: BrowserContext, directories: DirectoryFixture[] = []) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  if (directories.length) await installDirectories(context, directories, png.toString('base64'));
}
/** A visitor: a separate browser context with no cookies at all. */
const stranger = (browser: Browser, viewport = { width: 1440, height: 1000 }) => browser.newContext({ baseURL: process.env.DWS_BROWSER_BASE_URL, viewport });
const shoot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, style: WHOLE_PAGE });
const status = (page: Page) => page.getByTestId('batch-status');

/** Import one tree with no edits and wait for it to finish. Two files with the same bytes in one import can meet
 * mid-upload; the second then waits for the first's two-minute claim. As the recovery spec does, elapsed time is
 * simulated with fixture SQL rather than waited for. */
async function importTree(page: Page, label: string) {
  await page.goto('/migrate');
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.getByTestId('migration-source').filter({ hasText: label }).getByTestId('source-counts')).toContainText('photo', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Start import', exact: true }).click();
  for (let pass = 0; pass < 4; pass++) {
    await expect(status(page)).toHaveText(/Finished|Needs attention/, { timeout: 120_000 });
    if (await status(page).getAttribute('data-status') === 'completed') return;
    await fixtures.sql.query("update public.migration_items set retry_after=now()-interval '1 second' where status='retryable_failed' and retry_after is not null");
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
  }
  await expect(status(page)).toHaveAttribute('data-status', 'completed');
}

test('AC-21, AC-22, AC-23: share a project, open the link signed out, then turn it off', async ({ page, context, browser }, info) => {
  const project = (await fixtures.sql.query("select id from public.jobs where job_number='3612'")).rows[0].id as string;
  const label = `3612 Shared ${run}`;
  await signIn(context, [{ label, files: [photo('front.png'), photo('back.png')] }]);
  await importTree(page, label);
  // A private detail on every photo, to look for on the public page: a tag.
  await fixtures.sql.query("update public.photos set tags='{secret-share-tag}' where job_id=$1", [project]);
  const expected = (await fixtures.sql.query("select count(*)::int as n from public.photos where job_id=$1 and deleted_at is null and kind in ('image','video')", [project])).rows[0].n as number;

  await page.goto(`/photos/${project}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const popup = page.getByRole('dialog');
  // AC-23: the limit, in plain words, before anything is switched on.
  await expect(popup.getByTestId('share-limit')).toContainText('Turning the link off stops this page from opening. It cannot take back photos someone has already saved or copied the address of.');
  const toggle = popup.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(popup.getByLabel('Link', { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const link = await popup.getByLabel('Link', { exact: true }).inputValue();
  expect(link).toMatch(new RegExp(`^${process.env.DWS_BROWSER_BASE_URL}/s/[A-Za-z0-9_-]{43}$`));
  await shoot(page, info, 'share-popup-on');

  // Signed out: a different browser context with no cookies.
  const visitorContext = await stranger(browser); const visitor = await visitorContext.newPage();
  const response = await visitor.goto(link);
  expect(response!.status()).toBe(200);
  // Next adds `must-revalidate` to a rendered page by itself; what matters is that `no-store` is there.
  expect(response!.headers()['cache-control']).toContain('no-store'); expect(response!.headers()['x-robots-tag']).toContain('noindex');
  await expect(visitor.getByRole('heading', { level: 1, name: 'Office North' })).toBeVisible();
  await expect(visitor.getByTestId('shared-count')).toHaveText(`${expected} photo${expected === 1 ? '' : 's'}`);
  await expect(visitor.getByTestId('shared-grid').getByRole('button')).toHaveCount(expected);
  // No app chrome, and nothing private: not in what is shown, and not in what was sent.
  for (const chrome of ['Sign out', 'Import folders', 'Trash', 'Upload']) await expect(visitor.getByText(chrome, { exact: true })).toHaveCount(0);
  const sent = (await response!.text()) + JSON.stringify(await (await visitor.request.get(`/api/share/${link.split('/').pop()}`)).json());
  for (const secret of [UPLOADER, 'Rosalind', 'secret-share-tag', '.xmp', 'sidecar']) expect(sent, secret).not.toContain(secret);
  // View, step, and download.
  await visitor.getByTestId('shared-grid').getByRole('button').first().click();
  const viewer = visitor.getByRole('dialog');
  await expect(viewer).toContainText(`1 of ${expected}`);
  const download = viewer.getByRole('link', { name: 'Download' });
  await expect(download).toHaveAttribute('href', /\/storage\/v1\/object\/public\/photos\/originals\/.+download=/);
  if (expected > 1) { await visitor.keyboard.press('ArrowRight'); await expect(viewer).toContainText(`2 of ${expected}`); }
  await shoot(visitor, info, 'shared-viewer-desktop');
  await visitor.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
  await shoot(visitor, info, 'shared-page-desktop');
  // The same page on a phone.
  const phoneContext = await stranger(browser, { width: 390, height: 844 }); const phone = await phoneContext.newPage();
  await phone.goto(link);
  await expect(phone.getByRole('heading', { level: 1, name: 'Office North' })).toBeVisible();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shoot(phone, info, 'shared-page-phone');

  // AC-22: off, and the page is gone at once, for the visitor who already had it open.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const gone = await visitor.goto(link);
  expect(gone!.status()).toBe(404);
  await expect(visitor.getByRole('heading', { name: 'This link is not available' })).toBeVisible();
  await expect(visitor.getByText('Office North')).toHaveCount(0);
  await shoot(visitor, info, 'shared-page-off');
  // On again: a new link. The old one stays dead.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByLabel('Link', { exact: true })).not.toHaveValue(link);
  expect((await visitor.goto(link))!.status()).toBe(404);
  await toggle.click();
  await visitorContext.close(); await phoneContext.close();
});

test('G1-G6 end to end: folders become albums, a party has no project, copies join an album, and a client opens one link', async ({ page, context, browser }, info) => {
  test.setTimeout(420_000);
  const root = `Office ${run}`, party = `Christmas Party ${run}`, marketing = `Marketing ${run}`, kitchen = `3612 Kitchen ${run}`, stair = `4170 Stair ${run}`;
  const k = photo('kitchen.png'), s = photo('stair.png');
  await signIn(context, [{ label: root, folders: [
    { label: kitchen, files: [k, photo('kitchen-wide.png')] }, { label: stair, files: [s] },
    { label: party, files: [photo('party.png')] },
    // Hand-picked copies of two project photos, under other names.
    { label: marketing, files: [{ ...k, name: 'best-kitchen.png' }, { ...s, name: 'best-stair.png' }] },
  ] }]);
  await importTree(page, root);
  await shoot(page, info, 'e2e-import-finished');

  // G5: every folder is an album with the same name. G1: a photo can be in more than one.
  const albums = (await fixtures.sql.query(`select a.id,a.name,array_agg(p.original_name order by p.original_name) as photos from public.albums a
    join public.album_photos ap on ap.album_id=a.id join public.photos p on p.id=ap.photo_id where a.name like $1 group by a.id,a.name order by a.name`, [`%${run}`])).rows as Array<{ id: string; name: string; photos: string[] }>;
  expect(albums.map(row => row.name)).toEqual([kitchen, stair, party, marketing].sort());
  // Marketing holds the photos that already exist (whichever copy arrived first is "the" photo): two photos, no new rows.
  const imported = (await fixtures.sql.query(`select p.id,p.original_name,j.job_number from public.photos p left join public.jobs j on j.id=p.job_id
    where p.id in(select ap.photo_id from public.album_photos ap join public.albums a on a.id=ap.album_id where a.name like $1) order by p.original_name`, [`%${run}`])).rows;
  expect(imported).toHaveLength(4); // kitchen, kitchen-wide, stair, party: the two copies made no photo of their own
  const marketingAlbum = albums.find(row => row.name === marketing)!;
  expect(marketingAlbum.photos).toHaveLength(2);
  // G2: the party photo has no project, and the project photos were given theirs from the folder's name.
  const byAlbum = async (name: string) => (await fixtures.sql.query(`select j.job_number from public.photos p left join public.jobs j on j.id=p.job_id join public.album_photos ap on ap.photo_id=p.id
    join public.albums a on a.id=ap.album_id where a.name=$1 order by 1`, [name])).rows.map(row => row.job_number as string | null);
  expect(await byAlbum(party)).toEqual([null]);
  expect(await byAlbum(kitchen)).toEqual(['3612', '3612']); expect(await byAlbum(stair)).toEqual(['4170']);
  expect((await byAlbum(marketing)).sort()).toEqual(['3612', '4170']);

  // G4: pick photos across two projects, add them to Marketing, tag them, and filter by the tag.
  // MERGE NOTE: selecting photos in the grid is the screens branch's work (plan Phase 5) and does not exist on this
  // branch, so this one step calls the same routes that screen calls. After the merge, drive it through the grid.
  const wide = imported.find(row => row.original_name === 'kitchen-wide.png')!.id as string;
  const stairId = (await fixtures.sql.query('select ap.photo_id from public.album_photos ap join public.albums a on a.id=ap.album_id where a.name=$1', [stair])).rows[0].photo_id as string;
  const api = async (path: string, body: unknown) => page.evaluate(async ([url, payload]) => {
    const response = await fetch(url as string, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }, [path, body] as const);
  expect(await api(`/api/photo-albums/${marketingAlbum.id}/photos`, { photo_ids: [wide, stairId] })).toMatchObject({ status: 200, body: { added: 1, already: 1 } });
  expect(await api('/api/photos/tags', { photo_ids: [wide, stairId], add: ['Professional'] })).toMatchObject({ status: 200, body: { updated: 2 } });
  const filtered = await page.evaluate(async album => (await (await fetch(`/api/photos?album=${album}&tags=professional`)).json()).photos.map((row: { id: string }) => row.id), marketingAlbum.id);
  expect(filtered.sort()).toEqual([wide, stairId].sort());

  // G6: share Marketing, and a client opens the link with no login. Marketing now holds three photos from two projects.
  const made = await page.evaluate(async album => (await fetch('/api/photo-share', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ album_id: album, enabled: true }) })).json(), marketingAlbum.id);
  const clientContext = await stranger(browser); const client = await clientContext.newPage();
  expect((await client.goto(made.url))!.status()).toBe(200);
  await expect(client.getByRole('heading', { level: 1, name: marketing })).toBeVisible();
  await expect(client.getByTestId('shared-count')).toHaveText('3 photos');
  await expect(client.getByTestId('shared-grid').getByRole('button')).toHaveCount(3);
  const seen = await client.content();
  for (const secret of [UPLOADER, 'professional', party, kitchen, '3612', '4170']) expect(seen, secret).not.toContain(secret);
  await shoot(client, info, 'e2e-client-opens-marketing');
  await clientContext.close();
});
