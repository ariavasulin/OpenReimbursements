import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const jobs = [randomUUID(), randomUUID()];
test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  for (let i = 0; i < jobs.length; i++) await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [jobs[i], `ACTION-${i}-${randomUUID().slice(0, 6)}`, ['Action North', 'Action South'][i]]);
});
test.afterAll(async () => { await fixtures?.close(); });
async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
async function seed(name: string, options: { uploader?: string; bytes?: Buffer; trash?: boolean } = {}) {
  const id = randomUUID();
  const bytes = options.bytes ?? Buffer.concat([png, randomBytes(16)]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const uploader = options.uploader ?? fixtures.employeeA.id;
  const path = `originals/${uploader}/${id}/${name}`;
  const upload = await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' });
  expect(upload.error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at,deleted_at,deleted_by,purge_after)
    values($1,$2,$3,'image',$4,$5,$6,'image/png',$7,$5,now(),case when $8 then now() end,case when $8 then $3::uuid end,case when $8 then now()+interval '30 days' end)`, [id, jobs[0], uploader, name, path, bytes.length, digest, options.trash ?? false]);
  return { id, bytes, digest, path };
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true,
    style: 'div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`exact move, trash and restore are reviewable on ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport); await authenticate(context);
    const photo = await seed(`retained-${viewport.name}.png`);
    await page.goto(`/photos/actions?action=move&photo=${photo.id}&destination=${jobs[1]}`);
    await page.getByRole('button', { name: 'Review exact targets' }).click();
    await expect(page.getByTestId('action-count')).toHaveText('1 exact target');
    await expect(page.getByTestId('action-item')).toContainText(`retained-${viewport.name}.png`);
    const confirm = page.getByRole('button', { name: 'Confirm move', exact: true });
    await expect(confirm).toBeEnabled(); await confirm.focus(); await expect(confirm).toBeFocused();
    expect((await fixtures.sql.query('select job_id from public.photos where id=$1', [photo.id])).rows[0].job_id).toBe(jobs[0]);
    await capture(page, info, `${viewport.name}-move-confirmation`);
    await confirm.click(); await expect(page.getByTestId('action-status')).toContainText('completed');
    expect((await fixtures.sql.query('select job_id from public.photos where id=$1', [photo.id])).rows[0].job_id).toBe(jobs[1]);

    await page.goto(`/photos/actions?action=trash&photo=${photo.id}`);
    await page.getByRole('button', { name: 'Review exact targets' }).click();
    await expect(page.getByText(/known public file URL/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm move to trash' })).toBeEnabled();
    await capture(page, info, `${viewport.name}-trash-confirmation`);
    await page.getByRole('button', { name: 'Confirm move to trash' }).click();
    await expect(page.getByTestId('action-status')).toContainText('completed');
    const trashed = (await fixtures.sql.query('select deleted_at,purge_after from public.photos where id=$1', [photo.id])).rows[0];
    expect(new Date(trashed.purge_after).getTime() - new Date(trashed.deleted_at).getTime()).toBe(30 * 86400_000);
    const publicFile = await context.request.get(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/photos/${photo.path}`);
    expect(publicFile.ok()).toBe(true);

    await page.goto(`/photos/${jobs[1]}?photo=${photo.id}`);
    await expect(page.getByText(/couldn.t find|not found|no longer/i).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/photos/trash');
    const row = page.getByTestId('trash-photo').filter({ hasText: `retained-${viewport.name}.png` });
    await expect(row).toContainText('Restore before');
    await capture(page, info, `${viewport.name}-trash-list`);
    await row.getByRole('link', { name: 'Review restore', exact: true }).click();
    await page.getByRole('button', { name: 'Review exact targets' }).click();
    await expect(page.getByTestId('action-item')).toContainText('In trash');
    await expect(page.getByRole('button', { name: 'Confirm restore', exact: true })).toBeEnabled();
    await capture(page, info, `${viewport.name}-restore-confirmation`);
    if (viewport.name === 'phone') { await page.getByTestId('action-item').scrollIntoViewIfNeeded(); await capture(page, info, 'phone-restore-exact-target'); }
    await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
    await expect(page.getByTestId('action-status')).toContainText('completed');
    expect((await fixtures.sql.query('select deleted_at,job_id from public.photos where id=$1', [photo.id])).rows[0]).toMatchObject({ deleted_at: null, job_id: jobs[1] });
    await expect(page.getByRole('button', { name: 'Refresh results', exact: true })).toBeEnabled();
    await capture(page, info, `${viewport.name}-restored`);
    await writeFile(info.outputPath('retention-action-evidence.json'), JSON.stringify({ photoId: photo.id, trashed, knownPublicUrlStatus: publicFile.status(), deepLink: 'Trash did not open a lightbox', restoredToJob: jobs[1] }, null, 2));
  });
}

test('phone upload preserves queue across a denied ordinary restore, then resolves after MCP restore without duplicate bytes', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await authenticate(context);
  const photo = await seed('someone-elses-trash.png', { uploader: fixtures.employeeB.id, trash: true });
  const transfers: string[] = [];
  page.on('request', request => { if (request.url().includes('/storage/v1/') && ['POST', 'PATCH', 'PUT'].includes(request.method())) transfers.push(new URL(request.url()).pathname); });
  await page.goto(`/photos/${jobs[0]}`);
  await page.locator('input[type=file][multiple]').first().setInputFiles({ name: 'same-photo.png', mimeType: 'image/png', buffer: photo.bytes });
  await page.getByRole('button', { name: 'Upload 1 file', exact: true }).click();
  await page.getByRole('button', { name: /1 upload needs attention/ }).click();
  await expect(page.getByText('Ask an administrator to restore this photo, or use the MCP restore handoff.', { exact: true }).first()).toBeVisible();
  await capture(page, info, 'phone-other-owner-remedy');
  await page.getByRole('link', { name: 'Review restore', exact: true }).click();
  await page.getByRole('button', { name: 'Review exact targets' }).click();
  // The real ordinary route must reject this actor, regardless of the UI link.
  await expect(page.locator('main').getByRole('alert')).toContainText('not permitted');
  await page.getByRole('button', { name: /1 upload needs attention/ }).click();
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
  expect(transfers).toEqual([]);
  const token = randomBytes(32).toString('base64url');
  const tokenDigest = createHash('sha256').update(token).digest('hex');
  const handoff = await fixtures.admin.from('dws_action_handoffs').insert({ token_digest: tokenDigest, script_name: 'restore_photos', expires_at: new Date(Date.now() + 180_000).toISOString(), requested_input: { selector: { photos: [{ photo_id: photo.id }] } } });
  expect(handoff.error).toBeNull();
  const authorized = await context.newPage(); await authorized.setViewportSize({ width: 390, height: 844 });
  await authorized.goto(`/photo-actions?token=${token}&script_name=restore_photos`);
  await expect(authorized).toHaveURL(/\/photo-actions\?batch=[a-f0-9-]+$/);
  expect(authorized.url()).not.toContain(token);
  await expect(authorized.getByRole('button', { name: 'Confirm restore', exact: true })).toBeEnabled();
  await capture(authorized, info, 'phone-mcp-restore-confirmation');
  await authorized.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await expect(authorized.getByTestId('action-status')).toContainText('completed');
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('button', { name: /1 photo already in this job/ })).toBeVisible();
  expect(transfers).toEqual([]);
  expect((await fixtures.sql.query('select count(*)::int as count from public.photos where content_sha256=$1', [photo.digest])).rows[0].count).toBe(1);
  const binding = (await fixtures.sql.query('select photo_action_batch_id,consumed_by from public.dws_action_handoffs where token_digest=$1', [tokenDigest])).rows[0];
  expect(binding.consumed_by).toBe(fixtures.employeeA.id);
  await page.getByRole('link', { name: 'DWS Photos', exact: true }).click();
  await expect(page).toHaveURL(/\/photos$/);
  await expect(page.locator('main').getByRole('link', { name: /Action North/ }).getByText('1 photo', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /1 photo already in this job/ })).toBeVisible();
  await expect(page.getByText('1 upload needs attention — open the tray', { exact: true })).toBeHidden();
  await capture(page, info, 'phone-upload-resolved');
  await writeFile(info.outputPath('ordinary-mcp-remedy.json'), JSON.stringify({ photoId: photo.id, transfers, binding, canonicalCount: 1, libraryCountAfterRetry: 1, queue: 'Same retained file resolved with Check again after navigation and authorized restore' }, null, 2));
});

test('MCP filename ambiguity requires a visible exact choice before confirmation', async ({ page, context }, info) => {
  await authenticate(context);
  const filename = `ambiguous-${randomUUID().slice(0, 8)}.png`;
  const first = await seed(filename), second = await seed(filename);
  const jobNumber = (await fixtures.sql.query('select job_number from public.jobs where id=$1', [jobs[0]])).rows[0].job_number;
  const destinationNumber = (await fixtures.sql.query('select job_number from public.jobs where id=$1', [jobs[1]])).rows[0].job_number;
  const token = randomBytes(32).toString('base64url');
  const inserted = await fixtures.admin.from('dws_action_handoffs').insert({ token_digest: createHash('sha256').update(token).digest('hex'), script_name: 'move_photos', expires_at: new Date(Date.now() + 180_000).toISOString(), requested_input: { selector: { photos: [{ job_number: jobNumber, original_filename: filename }] }, destination_job_number: destinationNumber } });
  expect(inserted.error).toBeNull();
  await page.goto(`/photo-actions?token=${token}&script_name=move_photos`);
  await expect(page.getByRole('heading', { name: /Choose the matching photo/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose this photo', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Confirm move', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Choose this photo', exact: true }).first()).toBeEnabled();
  await capture(page, info, 'desktop-ambiguous-reference');
  await page.locator(`a[href="/photos/${jobs[0]}?photo=${first.id}"]`).locator('..').locator('..').getByRole('button', { name: 'Choose this photo' }).click();
  await expect(page.getByTestId('action-count')).toHaveText('1 exact target');
  await expect(page.getByTestId('action-item').getByRole('link', { name: 'View photo', exact: true })).toHaveAttribute('href', `/photos/${jobs[0]}?photo=${first.id}`);
  await expect(page.getByRole('button', { name: 'Confirm move', exact: true })).toBeEnabled();
  await capture(page, info, 'desktop-selected-reference');
  await page.getByRole('button', { name: 'Confirm move', exact: true }).click();
  await expect(page.getByTestId('action-status')).toContainText('completed');
  const rows = (await fixtures.sql.query('select id,job_id from public.photos where id=any($1::uuid[])', [[first.id, second.id]])).rows;
  expect(rows.find(row => row.id === first.id).job_id).toBe(jobs[1]);
  expect(rows.find(row => row.id === second.id).job_id).toBe(jobs[0]);
});
