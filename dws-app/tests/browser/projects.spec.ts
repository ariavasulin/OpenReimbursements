import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories } from './directory-fixture';

// Hand-made projects (photo-folders AC-1, AC-4, AC-5, AC-7).
let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let png: Buffer;
const source = randomUUID();
const tag = randomUUID().slice(0, 6);

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [source, `PROJ-${tag}`, `Harbor remodel ${tag}`]);
});
test.afterAll(async () => { await fixtures?.close(); });
test.beforeEach(async ({ context }) => {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
});

test('a project created from the move page receives the photo, and can be renamed', async ({ page }) => {
  const id = randomUUID();
  const bytes = Buffer.concat([png, randomBytes(16)]);
  const path = `originals/${fixtures.employeeA.id}/${id}/project.png`;
  expect((await fixtures.admin.storage.from('photos').upload(path, bytes, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query(`insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,thumb_path,captured_at)
    values($1,$2,$3,'image','project.png',$4,$5,'image/png',$6,$4,now())`, [id, source, fixtures.employeeA.id, path, bytes.length, createHash('sha256').update(bytes).digest('hex')]);

  await page.goto(`/photos/actions?action=move&photo=${id}`);
  await page.getByRole('button', { name: 'New project' }).click();
  // Typing part of an existing name offers that project before a duplicate is made.
  await page.getByLabel('Project name').fill(`harbor remodel ${tag}`);
  await expect(page.getByRole('button', { name: new RegExp(`Use #PROJ-${tag}`) })).toBeVisible();
  const name = `Office party ${tag}`;
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByLabel('Project name')).toBeHidden();
  const created = (await fixtures.sql.query('select id,job_number,created_by from public.jobs where name=$1', [name])).rows[0];
  expect(created.job_number).toMatch(/^P-\d+$/);
  expect(created.created_by).toBe(fixtures.employeeA.id);

  await page.getByRole('button', { name: 'Review exact targets' }).click();
  await page.getByRole('button', { name: 'Confirm move', exact: true }).click();
  await expect(page.getByTestId('action-status')).toContainText('completed');
  expect((await fixtures.sql.query('select job_id from public.photos where id=$1', [id])).rows[0].job_id).toBe(created.id);

  await page.goto(`/photos/${created.id}`);
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Project name').fill(`Holiday party ${tag}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Holiday party ${tag}`);
  expect((await fixtures.sql.query('select name,job_number from public.jobs where id=$1', [created.id])).rows[0])
    .toEqual({ name: `Holiday party ${tag}`, job_number: created.job_number });
});

test('an MCP-suggested project name is pre-filled and created only on confirmation', async ({ page, context }) => {
  if (!process.env.MCP_SHARED_KEY) throw new Error('MCP browser proof requires the isolated harness key.');
  const client = new Client({ name: 'dws-project-suggestion', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`/mcp/${process.env.MCP_SHARED_KEY}`, process.env.DWS_BROWSER_BASE_URL)));
  const suggestion = `Shop photos ${tag}`;
  const result = await client.callTool({ name: 'execute_dws_script', arguments: { script_name: 'migrate_photos',
    input: { sources: [{ label: 'Shop folder', new_project_name: suggestion }] } } });
  await client.close();
  expect(result.isError).not.toBe(true);
  const { handoff_url } = JSON.parse((result.content as Array<{ text?: string }>)[0].text!) as { handoff_url: string };

  await installDirectories(context, [{ label: 'Shop folder', files: [{ name: 'shop.png', bytes: 4096, seed: 11 }] }], png.toString('base64'));
  await page.goto(handoff_url);
  await page.getByRole('button', { name: 'Select folder', exact: true }).click();
  const offer = page.getByRole('button', { name: `New project “${suggestion}”` });
  await expect(offer).toBeVisible();
  expect((await fixtures.sql.query('select 1 from public.jobs where name=$1', [suggestion])).rowCount).toBe(0);
  await offer.click();
  await expect(page.getByLabel('Project name')).toHaveValue(suggestion);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByLabel('Project name')).toBeHidden();
  const created = (await fixtures.sql.query('select id from public.jobs where name=$1', [suggestion])).rows[0];
  await expect(page.getByLabel('Destination job for Shop folder')).toHaveValue(created.id);
});
