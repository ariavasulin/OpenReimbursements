import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures, type FixtureActor } from '../../integration/fixtures';
import { TRASH_RULE_MESSAGE } from '../../src/lib/photos/permissions';

// On screen: a non-admin is never shown a delete control that will fail, a mixed selection says how
// many can go, and a photo admin sees everything.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const run = randomUUID().slice(0, 6);
const made: string[] = [];
test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true');
});
test.afterAll(async () => {
  if (fixtures) await fixtures.sql.query('delete from public.photos where id=any($1::uuid[])', [made]);
  await fixtures?.close();
});

async function signIn(context: BrowserContext, actor: FixtureActor) {
  await context.clearCookies();
  await context.addCookies(actor.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
async function project(label: string) {
  const id = randomUUID();
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [id, `RULE-${label}-${run}`, `Delete rule ${label}`]);
  return id;
}
async function seed(jobId: string, name: string, uploader: string, daysAgo = 0) {
  const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16)]);
  const path = `originals/${uploader}/${id}/${name}`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  // Named by hand after the file, so tiles can be found by that name under automatic naming.
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,display_name,name_source,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at,created_at)
    values($1,$2,$3,'image',$4,$4,'manual',$5,$6,'image/png',$7,$5,now(),now()-make_interval(days=>$8))`,
    [id, jobId, uploader, name, path, bytes.length, createHash('sha256').update(bytes).digest('hex'), daysAgo]);
  made.push(id);
  return id;
}
const tile = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).last();
const tick = (page: Page, name: string) => page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).last();
const bar = (page: Page) => page.getByRole('region', { name: 'Selected photos' });
async function select(page: Page, phone: boolean, names: string[]) {
  const [first, ...rest] = names;
  if (phone) {
    const box = (await tile(page, first).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
    for (const name of rest) await tile(page, name).click();
  } else {
    await tile(page, first).hover(); await tick(page, first).click();
    for (const name of rest) await tick(page, name).click();
  }
}
/** Load a page and wait until it knows who is signed in, so a missing control is a decision, not a page still loading. */
async function open(page: Page, url: string) {
  const actor = page.waitForResponse(response => response.url().endsWith('/api/photos/actor') && response.ok());
  await page.goto(url);
  await actor;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true,
    style: 'div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  const phone = viewport.name === 'phone';

  test(`a mixed selection trashes only the photos the employee may delete, on ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport); await signIn(context, fixtures.employeeA);
    const job = await project(`mixed-${viewport.name}`);
    const own = [0, 1, 2].map(n => `own-${n}-${viewport.name}-${run}.png`);
    const old = `own-old-${viewport.name}-${run}.png`;
    const theirs = [0, 1].map(n => `theirs-${n}-${viewport.name}-${run}.png`);
    const ids: Record<string, string> = {};
    await Promise.all([
      ...own.map(async name => { ids[name] = await seed(job, name, fixtures.employeeA.id, 1); }),
      (async () => { ids[old] = await seed(job, old, fixtures.employeeA.id, 31); })(),
      ...theirs.map(async name => { ids[name] = await seed(job, name, fixtures.employeeB.id, 1); }),
    ]);

    await page.goto(`/photos/${job}`);
    await expect(tile(page, own[0])).toBeVisible();
    // Only colleagues' photos (and an old one of mine): no Trash at all, the other tools stay.
    await select(page, phone, [...theirs, old]);
    await expect(bar(page)).toContainText('3 selected');
    await expect(bar(page).getByRole('button', { name: /Trash/ })).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'Tag', exact: true })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Clear selection' }).click();

    // A mixed selection says how many can go, rather than offering a button that fails.
    await select(page, phone, [...own, old, ...theirs]);
    await expect(bar(page)).toContainText('6 selected');
    const trash = bar(page).getByTestId('selection-trash');
    await expect(trash).toHaveText('Trash the 3 you can delete');
    await capture(page, info, `${viewport.name}-mixed-selection`);
    await trash.click();
    await expect(page).toHaveURL(/\/photos\/actions\?batch=/);
    await expect(page.getByTestId('action-question')).toHaveText('Move 3 photos to trash?');
    await expect(page.getByTestId('action-item')).toHaveCount(3);
    await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(page.getByTestId('action-status')).toHaveText('Done');
    const rows = (await fixtures.sql.query('select id,deleted_at from public.photos where id=any($1::uuid[])', [Object.values(ids)])).rows;
    const trashed = new Set(rows.filter(row => row.deleted_at !== null).map(row => row.id));
    expect(Object.keys(ids).filter(name => trashed.has(ids[name])).sort()).toEqual([...own].sort());

    // The viewer: a colleague's photo has no Move to trash, and says why.
    await page.goto(`/photos/${job}?photo=${ids[theirs[0]]}`);
    if (phone) await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByTestId('trash-rule')).toHaveText(TRASH_RULE_MESSAGE);
    await expect(page.getByRole('link', { name: 'Move to trash', exact: true })).toHaveCount(0);
    await capture(page, info, `${viewport.name}-viewer-explains`);
  });

  test(`delete forever, empty trash, and project delete are shown to photo admins only, on ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport);
    const job = await project(`admin-${viewport.name}`);
    const name = `trashed-${viewport.name}-${run}.png`;
    const id = await seed(job, name, fixtures.employeeB.id, 1);
    await fixtures.sql.query("update public.photos set deleted_at=now(),deleted_by=uploader_id,purge_after=now()+interval '30 days' where id=$1", [id]);

    await signIn(context, fixtures.employeeA);
    await open(page, '/photos/trash');
    const row = page.getByTestId('trash-photo').filter({ hasText: name });
    await expect(row.getByRole('link', { name: 'Restore', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Empty trash', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Delete forever|Select all on this page/ })).toHaveCount(0);
    await expect(row.getByRole('checkbox')).toHaveCount(0);
    await capture(page, info, `${viewport.name}-trash-employee`);
    await open(page, `/photos/${job}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Delete rule admin-${viewport.name}`);
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete project', exact: true })).toHaveCount(0);
    await open(page, '/photos/projects');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected projects' }).getByRole('button', { name: /Delete/ })).toHaveCount(0);

    await signIn(context, fixtures.photoAdmin);
    await page.goto('/photos/trash');
    await expect(page.getByRole('button', { name: 'Empty trash', exact: true })).toBeVisible();
    await expect(page.getByTestId('trash-photo').filter({ hasText: name }).getByRole('button', { name: 'Delete forever', exact: true })).toBeVisible();
    await capture(page, info, `${viewport.name}-trash-admin`);
    await page.goto(`/photos/${job}`);
    await expect(page.getByRole('button', { name: 'Delete project', exact: true })).toBeVisible();
  });
}
