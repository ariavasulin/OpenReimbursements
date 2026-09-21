import { test, expect, type BrowserContext } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';

// plans/active/photo-albums/plan.md, Phase 3: the project is optional, and no screen that
// exists today may break on a photo without one. There is no screen that creates such a
// photo yet (Phase 4), so this file writes the row directly and then walks every place the
// current app can show it: search results, the viewer, the confirm page, and the trash.
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const project = randomUUID();
const made: string[] = [];

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [project, `NOPROJ-${randomUUID().slice(0, 6)}`, 'Has A Project']);
});
test.afterAll(async () => {
  if (!fixtures) return;
  await fixtures.sql.query('delete from public.photos where id=any($1::uuid[])', [made]);
  await fixtures.close();
});

async function authenticate(context: BrowserContext) {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
}
async function seed(name: string, jobId: string | null, tag: string) {
  const id = randomUUID(); const bytes = Buffer.concat([png, randomBytes(16)]);
  const path = `originals/${fixtures.employeeA.id}/${id}/${name}`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at,tags)
    values($1,$2,$3,'image',$4,$5,$6,'image/png',$7,$5,now(),$8)`,
    [id, jobId, fixtures.employeeA.id, name, path, bytes.length, createHash('sha256').update(bytes).digest('hex'), [tag]]);
  made.push(id);
  return id;
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`a photo with no project renders as "No project" and breaks nothing on ${viewport.name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await authenticate(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const crashes: string[] = [];
    page.on('pageerror', error => crashes.push(error.message));
    const tag = `noproject-${viewport.name}-${randomUUID().slice(0, 8)}`;
    const loose = await seed(`loose-${viewport.name}.png`, null, tag);
    await seed(`owned-${viewport.name}.png`, project, tag);

    // Search groups by project: the photo without one gets its own "No project" group.
    await page.goto(`/photos/search?q=${tag}`);
    await expect(page.getByRole('heading', { name: /^No project · 1 photo$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Has A Project · 1 photo$/ })).toBeVisible();
    // "No project" is not a job: two photos, one job.
    await expect(page.getByText(`2 photos across 1 job · "${tag}"`, { exact: true })).toBeVisible();

    // The viewer names it "No project", and Copy link works without a project in the path.
    // At desktop the tile's name also carries its hover caption (date and uploader), so match the start.
    await page.getByRole('button', { name: new RegExp(`^loose-${viewport.name}\\.png`) }).click();
    await expect(page.getByTestId('photo-project')).toHaveText('No project');
    const copy = page.getByRole('button', { name: 'Copy link', exact: true });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${process.env.DWS_BROWSER_BASE_URL}/photos?photo=${loose}`);

    // The confirm page lists it, says "No project", and links to it without "/photos/null".
    await page.goto(`/photos/actions?action=trash&photo=${loose}`);
    await page.getByRole('button', { name: 'Review exact targets' }).click();
    const item = page.getByTestId('action-item');
    await expect(item).toContainText('Expected job: No project');
    await expect(item.getByRole('link', { name: 'View photo', exact: true })).toHaveAttribute('href', `/photos?photo=${loose}`);
    await page.getByRole('button', { name: 'Confirm move to trash' }).click();
    await expect(page.getByTestId('action-status')).toContainText('completed');

    // The trash names it the same way, and a restore leaves it active and still without a project.
    await page.goto('/photos/trash');
    const row = page.getByTestId('trash-photo').filter({ hasText: `loose-${viewport.name}.png` });
    await expect(row).toContainText('No project');
    await row.getByRole('link', { name: 'Review restore', exact: true }).click();
    await page.getByRole('button', { name: 'Review exact targets' }).click();
    await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
    await expect(page.getByTestId('action-status')).toContainText('completed');
    expect((await fixtures.sql.query('select job_id,deleted_at from public.photos where id=$1', [loose])).rows[0]).toEqual({ job_id: null, deleted_at: null });

    // A move to "No project". No screen offers it yet (Phase 5), so the draft is made through the
    // API from the signed-in page; the confirm page must still read it correctly and apply it.
    const owned = await seed(`moving-${viewport.name}.png`, project, tag);
    const batch = await page.evaluate(async (photoId) => {
      const response = await fetch('/api/photo-actions/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'move', selector: { photos: [{ photo_id: photoId }] }, destination_job_id: null }) });
      return (await response.json()).batch.id as string;
    }, owned);
    await page.goto(`/photos/actions?batch=${batch}`);
    await expect(page.getByText('Destination: No project', { exact: true })).toBeVisible();
    await expect(page.getByTestId('action-item')).toContainText(`moving-${viewport.name}.png`);
    await page.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(page.getByTestId('action-status')).toContainText('completed');
    expect((await fixtures.sql.query('select job_id,deleted_at from public.photos where id=$1', [owned])).rows[0]).toEqual({ job_id: null, deleted_at: null });

    expect(crashes).toEqual([]);
    await expect(page.locator('body')).not.toContainText('/photos/null');
  });
}
