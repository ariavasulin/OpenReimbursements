import { test, expect, type Page, type BrowserContext, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories, type DirectoryFixture } from './directory-fixture';

let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const jobs = [randomUUID(), randomUUID()];
const largeBytes = 13 * 1024 * 1024 + 37;

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query("create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null");
  await fixtures.sql.query("update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true");
  for (let i = 0; i < jobs.length; i++) {
    jobs[i] = (await fixtures.sql.query("insert into public.jobs(id,job_number,name) values($1,$2,$3) on conflict(job_number) do update set name=excluded.name returning id", [jobs[i], ['3612','4170'][i], ['Office North','Office South'][i]])).rows[0].id;
  }
});
test.afterAll(async () => { await fixtures?.close(); });

async function authenticate(context: BrowserContext, directories: DirectoryFixture[]) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  await installDirectories(context, directories, png.toString('base64'));
}
async function selectFolder(page: Page, label: string, job: string) {
  await page.getByRole('button', { name: 'Select folder', exact: true }).click();
  await page.getByLabel(`Destination job for ${label}`).selectOption(job);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.locator('main').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true,
    // This development-only launcher otherwise covers the compact footer.
    style: 'div:has(> button[aria-label="Open Tanstack query devtools"]) { visibility: hidden !important; }',
  });
}
async function batchId() {
  return (await fixtures.sql.query('select id from public.migration_batches where created_by=$1 order by created_at desc limit 1', [fixtures.employeeA.id])).rows[0].id as string;
}
async function batchPhotos(batch: string) {
  return (await fixtures.sql.query('select p.id,p.job_id,p.original_name,p.original_path,p.original_bytes,p.content_sha256 from public.photos p join public.migration_items i on i.photo_id=p.id where i.source_id in(select id from public.migration_sources where batch_id=$1) order by p.original_name', [batch])).rows;
}

test('100,000 lazy entries exceed 100 GB with bounded requests, rows, and previews', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  await authenticate(context, [{ label: 'Corpus 3612', count: 100_000, metadataOnly: true }]);
  const chunks: Array<{ bytes: number; entries: number }> = [];
  const requests: Array<{ path: string; milliseconds: number; status: number }> = [];
  const starts = new Map<string, number>();
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (/\/(scan|chunks|seal)$/.test(path)) requests.push({ path, milliseconds: Date.now() - (starts.get(response.url()) ?? Date.now()), status: response.status() });
  });
  const workflowStarted = Date.now();
  page.on('request', request => {
    starts.set(request.url(), Date.now());
    if (request.url().includes('/chunks') && request.method() === 'POST') {
      const body = request.postDataBuffer()!;
      const json = JSON.parse(body.toString());
      chunks.push({ bytes: body.length, entries: json.entries.length });
    }
  });
  await page.goto('/migrate');
  await selectFolder(page, 'Corpus 3612', jobs[0]);
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
  await Promise.race([
    expect(page.getByTestId('batch-counts')).toContainText('100,000', { timeout: 540_000 }),
    page.locator('main').getByRole('alert').waitFor({ state: 'visible', timeout: 540_000 }).then(async () => { throw new Error(`Corpus scan failed: ${await page.locator('main').getByRole('alert').textContent()}`); }),
  ]);
  await expect(page.getByRole('button', { name: 'Approve and start', exact: true })).toBeEnabled();
  expect(chunks.length).toBeGreaterThanOrEqual(200);
  expect(Math.max(...chunks.map(chunk => chunk.bytes))).toBeLessThanOrEqual(1024 * 1024);
  expect(Math.max(...chunks.map(chunk => chunk.entries))).toBeLessThanOrEqual(500);
  const batch = await batchId();
  const totals = (await fixtures.sql.query('select count(*)::int as count,sum(original_bytes)::text as bytes from public.migration_items where source_id in(select id from public.migration_sources where batch_id=$1) and is_current', [batch])).rows[0];
  expect(totals.count).toBe(100_000); expect(Number(totals.bytes)).toBeGreaterThan(100_000_000_000);
  await expect(page.getByTestId('migration-item').first()).toBeVisible();
  expect(await page.getByTestId('migration-item').count()).toBeLessThanOrEqual(100);
  expect(await page.locator('img[src^="blob:"]').count()).toBeLessThanOrEqual(100);
  const firstPath = await page.getByTestId('migration-item').first().textContent();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByTestId('migration-item').first()).not.toHaveText(firstPath!);
  await screenshot(page, info, 'desktop-corpus-review');
  const observed = await page.evaluate(() => (window as unknown as { __directoryFixture: unknown }).__directoryFixture);
  expect((observed as { materializedBytes: number }).materializedBytes).toBe(0);
  await writeFile(info.outputPath('bounded-corpus.json'), JSON.stringify({ totals, chunks, requests, workflowThroughReviewMilliseconds: Date.now() - workflowStarted, fixture: observed }, null, 2));
  await page.getByRole('button', { name: 'Cancel batch', exact: true }).click();
  await expect(page.getByTestId('batch-status')).toContainText(/cancelled/i);
});

test('real worker and multi-chunk Storage recover B after A commits and a page closes', async ({ page, context }, info) => {
  const directories: DirectoryFixture[] = [
    { label: 'North 3612', files: [{ name: 'A.png', bytes: 4096, seed: 7 }] },
    { label: 'South 4170', files: [{ name: 'B.png', bytes: largeBytes, seed: 11 }] },
  ];
  await authenticate(context, directories);
  const tus: Array<{ method: string; bytes: number; url: string }> = [];
  const nextBodies: Array<{ path: string; bytes: number; contentType: string }> = [];
  let interrupted = false;
  page.on('request', request => {
    if (request.url().startsWith(process.env.DWS_BROWSER_BASE_URL!) && request.postDataBuffer()) nextBodies.push({ path: new URL(request.url()).pathname, bytes: request.postDataBuffer()!.length, contentType: request.headers()['content-type'] ?? '' });
    if (request.url().includes('/storage/v1/upload/resumable')) tus.push({ method: request.method(), bytes: request.postDataBuffer()?.length ?? 0, url: new URL(request.url()).pathname });
  });
  await page.route('**/storage/v1/upload/resumable/**', async route => {
    if (route.request().method() === 'PATCH') { interrupted = true; await new Promise<void>(resolve => page.once('close', () => resolve())); await route.abort().catch(() => {}); }
    else await route.continue();
  });
  await page.goto('/migrate');
  await selectFolder(page, directories[0].label, jobs[0]);
  await selectFolder(page, directories[1].label, jobs[1]);
  await screenshot(page, info, 'desktop-mapping');
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve and start', exact: true })).toBeEnabled();
  await expect(page.getByTestId('batch-counts')).toContainText('2');
  await screenshot(page, info, 'desktop-review');
  await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
  const batch = await batchId();
  await expect.poll(async () => (await batchPhotos(batch)).map(photo => photo.original_name)).toEqual(['A.png']);
  await expect.poll(() => interrupted).toBe(true);
  await expect(page.getByTestId('batch-counts')).toContainText('1 completed');
  await expect(page.getByTestId('batch-status')).toContainText(/running/i);
  await screenshot(page, info, 'desktop-progress');
  const attempt = (await fixtures.sql.query("select id,lease_generation,lease_expires_at from public.migration_items where source_id in(select id from public.migration_sources where batch_id=$1) and original_name='B.png'", [batch])).rows[0];
  const contender = await context.newPage();
  const contenderTransfers: string[] = [];
  contender.on('request', request => { if (request.url().includes('/storage/v1/') && ['POST', 'PATCH'].includes(request.method())) contenderTransfers.push(request.url()); });
  await contender.goto(`/migrate?batch=${batch}`);
  await expect(contender.getByTestId('batch-counts')).toContainText('2');
  // An actual second authenticated page attempts the same work through the route.
  const steal = await contender.evaluate(async itemId => {
    const response = await fetch('/api/photo-migrations/uploads/acquire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner_kind: 'migration', owner_id: itemId }) });
    return { status: response.status, body: await response.json() };
  }, attempt.id);
  expect(steal.status).toBe(409);
  expect((await fixtures.sql.query('select lease_generation from public.migration_items where id=$1', [attempt.id])).rows[0].lease_generation).toBe(attempt.lease_generation);
  expect(contenderTransfers).toEqual([]);
  await contender.close();
  const beforeClose = await page.evaluate(() => (window as unknown as { __directoryFixture: unknown }).__directoryFixture);
  await page.close();
  // Deterministic elapsed lease time after process death; no production clock hook.
  await fixtures.sql.query("update public.migration_items set lease_expires_at=now()-interval '1 second' where source_id in(select id from public.migration_sources where batch_id=$1) and status<>'completed'", [batch]);
  await fixtures.sql.query("update public.photo_content_claims set lease_expires_at=now()-interval '1 second' where migration_item_id in(select id from public.migration_items where source_id in(select id from public.migration_sources where batch_id=$1))", [batch]);
  const reopened = await context.newPage();
  const resumedPaths: string[] = [];
  reopened.on('request', request => { if (request.url().includes('/storage/v1/') && ['POST','PATCH'].includes(request.method())) resumedPaths.push(request.url()); });
  await reopened.goto(`/migrate?batch=${batch}`);
  await expect(reopened.getByText(/reselect/i).first()).toBeVisible();
  await expect(reopened.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  const reopenedBeforeSelection = await reopened.evaluate(() => (window as unknown as { __directoryFixture: { materializedBytes: number; metadataReads: number } }).__directoryFixture);
  expect(reopenedBeforeSelection.materializedBytes).toBe(0); expect(reopenedBeforeSelection.metadataReads).toBe(0);
  await screenshot(reopened, info, 'desktop-permission-loss');
  for (const source of directories) await reopened.getByRole('button', { name: `Reselect ${source.label}`, exact: true }).click();
  await reopened.getByRole('button', { name: 'Review files', exact: true }).click();
  await reopened.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(reopened.getByTestId('batch-status')).toContainText(/completed/i);
  const photos = await batchPhotos(batch);
  expect(photos.map(photo => photo.original_name)).toEqual(['A.png', 'B.png']);
  expect(photos.map(photo => photo.job_id)).toEqual(jobs);
  const b = photos[1];
  const downloaded = await fixtures.admin.storage.from('photos').download(b.original_path);
  expect(downloaded.error).toBeNull();
  const bytes = Buffer.from(await downloaded.data!.arrayBuffer());
  const expectedBytes = Buffer.alloc(largeBytes, 11); png.copy(expectedBytes);
  expect(bytes.equals(expectedBytes)).toBe(true);
  expect(b.content_sha256).toBe(createHash('sha256').update(expectedBytes).digest('hex'));
  expect(resumedPaths.some(path => path.includes(photos[0].id))).toBe(false);
  expect((beforeClose as { workerUrls: string[] }).workerUrls.length).toBeGreaterThan(0);
  expect((beforeClose as { maxWorkers: number }).maxWorkers).toBeLessThanOrEqual(2);
  expect(tus.some(request => request.bytes === 6 * 1024 * 1024)).toBe(true);
  expect(nextBodies.length).toBeGreaterThan(0);
  expect(nextBodies.every(request => request.bytes <= 1024 * 1024 && request.contentType.includes('application/json'))).toBe(true);
  const afterRecovery = await reopened.evaluate(() => (window as unknown as { __directoryFixture: { workerUrls: string[] } }).__directoryFixture);
  expect(afterRecovery.workerUrls).toHaveLength(1);
  await writeFile(info.outputPath('recovery-storage.json'), JSON.stringify({ leaseExpirySimulation: 'After the real page closes, fixture SQL advances unfinished item and claim leases past their two-minute expiration; no two-minute wall-clock wait or production clock hook.', batch, beforeClose, reopenedBeforeSelection, afterRecovery, tus, nextBodies, steal, resumedRequests: resumedPaths.length, bytes: bytes.length, sha256: b.content_sha256, photos }, null, 2));
  await screenshot(reopened, info, 'desktop-completed');
});

test('pause stops new scheduling and cancellation preserves only the finalize committed first', async ({ page, context }, info) => {
  await authenticate(context, [{ label: 'Cancel 3612', files: [
    { name: 'cancel-A.png', bytes: 4096, seed: 31 },
    { name: 'cancel-B.png', bytes: 4096, seed: 32 },
    { name: 'cancel-C.png', bytes: 4096, seed: 33 },
  ] }]);
  let permitOriginals = false;
  const pendingOriginals: Array<() => void> = [];
  await page.route('**/storage/v1/object/photos/**', async route => {
    if (route.request().method() === 'POST' && !permitOriginals) await new Promise<void>(resolve => pendingOriginals.push(resolve));
    await route.continue().catch(() => {});
  });
  await page.goto('/migrate');
  await selectFolder(page, 'Cancel 3612', jobs[0]);
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
  const batch = await batchId();
  await expect.poll(() => pendingOriginals.length).toBe(2);
  // Reproduce the observed race: stop aborts the originals, their real release
  // RPCs commit first, then the held batch pause reaches the server.
  let releasedBeforePause = 0;
  await page.route(`**/api/photo-migrations/batches/${batch}`, async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().action === 'pause') {
      await expect.poll(async () => {
        releasedBeforePause = (await fixtures.sql.query("select count(*)::int as count from public.migration_items where source_id in(select id from public.migration_sources where batch_id=$1) and status='retryable_failed' and error is null", [batch])).rows[0].count;
        return releasedBeforePause;
      }).toBe(2);
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('batch-status')).toContainText(/interrupted/i);
  const paused = (await fixtures.sql.query('select original_name,status,error from public.migration_items where source_id in(select id from public.migration_sources where batch_id=$1) order by original_name', [batch])).rows;
  expect(paused.filter(item => item.status === 'pending').length).toBeGreaterThanOrEqual(1);
  const released = paused.filter(item => item.status === 'retryable_failed' && item.error === null);
  expect(released).toHaveLength(2);
  expect(await batchPhotos(batch)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeHidden();
  await expect(page.getByTestId('inventory-table')).not.toContainText('uploading');
  for (const item of released) {
    const row = page.getByTestId('migration-item').filter({ hasText: item.original_name });
    await expect(row.getByText('Paused', { exact: true })).toHaveCSS('color', 'rgb(187, 187, 187)');
    await expect(row.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Skip', exact: true })).toHaveCount(0);
    await expect(row).not.toContainText('Upload failed');
  }
  await screenshot(page, info, 'desktop-paused');
  permitOriginals = true; pendingOriginals.forEach(resolve => resolve());
  await page.unroute('**/storage/v1/object/photos/**');
  let blockedFinalizes = 0;
  const blockedPayloads: unknown[] = [];
  let firstCommitName = '';
  let releaseFinalize!: () => void;
  const finalizationGate = new Promise<void>(resolve => { releaseFinalize = resolve; });
  await page.route('**/api/photos', async route => {
    if (route.request().method() === 'POST') {
      const name = route.request().postDataJSON().original_name;
      if (!firstCommitName) firstCommitName = name;
      else if (name !== firstCommitName) { blockedFinalizes++; blockedPayloads.push(route.request().postDataJSON()); await finalizationGate; }
    }
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => firstCommitName).not.toBe('');
  await expect.poll(async () => (await batchPhotos(batch)).map(photo => photo.original_name)).toEqual([firstCommitName]);
  await expect.poll(() => blockedFinalizes).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Cancel batch', exact: true }).click();
  await expect(page.getByTestId('batch-status')).toContainText(/cancelled/i);
  releaseFinalize();
  const lateFinalizeStatuses: number[] = [];
  for (const payload of blockedPayloads) {
    const response = await context.request.post('/api/photos', { data: payload, headers: { Origin: process.env.DWS_BROWSER_BASE_URL! } });
    lateFinalizeStatuses.push(response.status()); expect(response.status()).toBe(409);
  }
  await expect.poll(async () => (await batchPhotos(batch)).map(photo => photo.original_name)).toEqual([firstCommitName]);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeHidden();
  await screenshot(page, info, 'desktop-cancelled');
  await writeFile(info.outputPath('pause-cancel.json'), JSON.stringify({ batch, pauseOrder: 'upload-release-before-batch-pause', releasedBeforePause, paused, blockedFinalizes, lateFinalizeStatuses, committed: await batchPhotos(batch) }, null, 2));
});

test('typed Storage permission failure remains visible and unresolved', async ({ page, context }, info) => {
  await authenticate(context, [{ label: 'Error 4170', files: [{ name: 'error.png', bytes: 4096, seed: 61 }] }]);
  await page.route('**/storage/v1/object/photos/**', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: '403', error: 'AccessDenied', message: 'Upload permission denied' }) });
    else await route.continue();
  });
  await page.goto('/migrate');
  await selectFolder(page, 'Error 4170', jobs[1]);
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
  await expect(page.getByTestId('migration-item').first()).toContainText(/failed|permission/i);
  await expect(page.getByTestId('batch-status')).toContainText('Needs attention');
  await screenshot(page, info, 'desktop-error');
  expect(await batchPhotos(await batchId())).toEqual([]);
  await page.getByRole('button', { name: 'Cancel batch', exact: true }).click();
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`compact file selection shows mapping, count and keyboard focus at ${viewport.name}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport);
    await authenticate(context, []);
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = createHash('sha256').update(token).digest('hex');
    const inserted = await fixtures.admin.from('dws_action_handoffs').insert({ token_digest: tokenDigest, script_name: 'add_photos', expires_at: new Date(Date.now() + 180_000).toISOString(), requested_input: { job_number: '3612', sheet_number: 'S-7', tags: ['office'] } });
    expect(inserted.error).toBeNull();
    let consumeRequests = 0;
    page.on('request', request => { if (request.url().endsWith('/handoffs/consume')) consumeRequests++; });
    await page.goto(`/migrate?script_name=add_photos&token=${token}`);
    await expect(page).toHaveURL(/\/migrate\?batch=[a-f0-9-]+$/);
    expect(page.url()).not.toContain(token);
    expect(consumeRequests).toBe(1);
    const binding = (await fixtures.sql.query('select migration_batch_id,consumed_by from public.dws_action_handoffs where token_digest=$1', [tokenDigest])).rows;
    expect(binding).toHaveLength(1); expect(binding[0].consumed_by).toBe(fixtures.employeeA.id);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Sheet number', { exact: true })).toHaveValue('S-7');
    await expect(dialog.getByLabel('Tags', { exact: true })).toHaveValue('office');
    await dialog.getByLabel('Select photos', { exact: true }).setInputFiles([
      { name: 'compact-one.png', mimeType: 'image/png', buffer: png },
      { name: 'compact-two.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from([2])]) },
    ]);
    const mapping = dialog.getByRole('combobox');
    await mapping.selectOption(jobs[0]);
    await dialog.getByRole('button', { name: 'Review files', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Approve and start', exact: true })).toBeEnabled();
    await mapping.focus();
    await expect(mapping).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await expect(dialog).toContainText('2');
    await expect(mapping).toHaveValue(jobs[0]);
    await expect(dialog.getByRole('button', { name: 'Approve and start', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, info, `compact-${viewport.name}-review-focus`);
    await dialog.getByTestId('batch-counts').scrollIntoViewIfNeeded();
    await expect(dialog.getByTestId('batch-counts')).toContainText('2');
    await screenshot(page, info, `compact-${viewport.name}-review-totals`);
    await writeFile(info.outputPath('handoff-history.json'), JSON.stringify({ consumeRequests, binding, currentUrl: page.url(), strictMode: 'Next development default StrictMode effect replay enabled' }, null, 2));
  });
}
