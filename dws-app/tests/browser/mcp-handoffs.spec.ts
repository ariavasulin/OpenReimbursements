import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createFixtures } from '../../integration/fixtures';
import { installDirectories } from './directory-fixture';

let fixtures: Awaited<ReturnType<typeof createFixtures>>;
let client: Client;
let png: Buffer;
const jobs = [randomUUID(), randomUUID()];
const numbers = jobs.map((id, index) => `MCP-${index}-${id.slice(0, 6)}`);

test.beforeAll(async () => {
  fixtures = await createFixtures();
  png = await readFile('src/lib/photos/__fixtures__/no-exif.png');
  await fixtures.sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  await fixtures.sql.query('update public.photo_release_state set photo_writes_enabled=true,mcp_enabled=true');
  for (let i = 0; i < jobs.length; i++) await fixtures.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [jobs[i], numbers[i], `MCP destination ${i}`]);
  if (!process.env.MCP_SHARED_KEY) throw new Error('MCP browser proof requires the isolated harness key.');
  client = new Client({ name: 'dws-browser-handoff-proof', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`/mcp/${process.env.MCP_SHARED_KEY}`, process.env.DWS_BROWSER_BASE_URL)));
  } catch { throw new Error('Could not connect to isolated MCP endpoint.'); }
});
test.afterAll(async () => { await client?.close(); await fixtures?.close(); });

async function handoff(script_name: string, input: Record<string, unknown>) {
  let result;
  try { result = await client.callTool({ name: 'execute_dws_script', arguments: { script_name, input } }); }
  catch { throw new Error('Isolated MCP handoff call failed.'); }
  expect(result.isError).not.toBe(true);
  const block = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
  const output = JSON.parse(block!.text!) as { handoff_url: string; expires_at: string };
  expect(Object.keys(output).sort()).toEqual(['expires_at', 'handoff_url']);
  expect(output.handoff_url.includes(process.env.MCP_SHARED_KEY!)).toBe(false);
  return output;
}

test('all five MCP handoffs enter authenticated review and complete their bound browser workflow', async ({ page, context }, info) => {
  test.setTimeout(240_000);
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  await installDirectories(context, [{ label: 'MCP folder', files: [{ name: 'mcp-folder.png', bytes: 4096, seed: 73 }] }], png.toString('base64'));
  const evidence: Array<Record<string, unknown>> = [];
  for (const script of ['migrate_photos', 'add_photos']) {
    const input = script === 'migrate_photos'
      ? { sources: [{ label: 'MCP folder', job_number: numbers[0] }] }
      : { job_number: numbers[0], tags: ['mcp-proof'] };
    const output = await handoff(script, input);
    await page.goto(output.handoff_url);
    await expect(page).toHaveURL(/\/migrate\?batch=[a-f0-9-]+$/);
    const batch = new URL(page.url()).searchParams.get('batch')!;
    // Wait for the authenticated job lookup before exercising the hint mapping.
    await expect(page.getByLabel('Find destination job').last()).toBeVisible();
    const lookup = page.waitForResponse(response => response.url().includes(`/jobs?q=${numbers[0]}`) && response.status() === 200);
    await page.getByLabel('Find destination job').last().fill(numbers[0]);
    await lookup;
    if (script === 'migrate_photos') {
      await page.getByRole('button', { name: 'Select folder', exact: true }).click();
    } else {
      await expect(page.getByLabel('Tags', { exact: true })).toHaveValue('mcp-proof');
      await expect(page.getByLabel(/sheet/i)).toHaveCount(0);
      await page.getByLabel('Select photos', { exact: true }).setInputFiles({ name: 'mcp-added.png', mimeType: 'image/png', buffer: Buffer.concat([png, randomBytes(16)]) });
    }
    const destination = page.getByLabel(/^Destination job for/).last();
    await expect(destination).toHaveValue(jobs[0]);
    await page.getByRole('button', { name: 'Review files', exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'Approve and start', exact: true }).last()).toBeEnabled();
    await page.getByRole('button', { name: 'Approve and start', exact: true }).last().click();
    await expect(page.getByTestId('batch-status')).toContainText('completed');
    const binding = (await fixtures.sql.query('select script_name,consumed_by from public.dws_action_handoffs where migration_batch_id=$1', [batch])).rows[0];
    expect(binding).toEqual({ script_name: script, consumed_by: fixtures.employeeA.id });
    const photos = (await fixtures.sql.query('select p.id,p.job_id,p.tags from public.photos p join public.migration_items i on i.photo_id=p.id join public.migration_sources s on s.id=i.source_id where s.batch_id=$1', [batch])).rows;
    expect(photos).toHaveLength(1); expect(photos[0].job_id).toBe(jobs[0]);
    if (script === 'add_photos') expect(photos[0]).toMatchObject({ tags: ['mcp-proof'] });
    evidence.push({ script, batch, binding, photos });
  }

  // This photo belongs to a different employee. Any employee may act on it now,
  // so what this proves is the MCP binding: each batch is tied to its hand-off script.
  const photo = randomUUID();
  const original = Buffer.concat([png, randomBytes(16)]);
  const path = `originals/${fixtures.employeeB.id}/${photo}/mcp-actions.png`;
  expect((await fixtures.admin.storage.from('photos').upload(path, original, { contentType: 'image/png' })).error).toBeNull();
  await fixtures.sql.query("insert into public.photos(id,job_id,uploader_id,kind,original_name,original_path,original_bytes,mime_type,content_sha256,captured_at) values($1,$2,$3,'image','mcp-actions.png',$4,$5,'image/png',$6,now())", [photo, jobs[0], fixtures.employeeB.id, path, original.length, createHash('sha256').update(original).digest('hex')]);
  for (const script of ['move_photos', 'remove_photos', 'restore_photos']) {
    const output = await handoff(script, { selector: { photos: [{ photo_id: photo }] }, ...(script === 'move_photos' ? { destination_job_number: numbers[1] } : {}) });
    await page.goto(output.handoff_url);
    await expect(page).toHaveURL(/\/photo-actions\?batch=[a-f0-9-]+$/);
    const batch = new URL(page.url()).searchParams.get('batch')!;
    await expect(page.getByTestId('action-count')).toHaveText('1 photo');
    const confirmation = script === 'move_photos' ? 'Move photo' : script === 'remove_photos' ? 'Move to trash' : 'Restore photo';
    await expect(page.getByRole('button', { name: confirmation, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: confirmation, exact: true }).click();
    await expect(page.getByTestId('action-status')).toHaveText('Done');
    const binding = (await fixtures.sql.query('select script_name,consumed_by from public.dws_action_handoffs where photo_action_batch_id=$1', [batch])).rows[0];
    expect(binding).toEqual({ script_name: script, consumed_by: fixtures.employeeA.id });
    const state = (await fixtures.sql.query('select job_id,deleted_at from public.photos where id=$1', [photo])).rows[0];
    expect(state.job_id).toBe(jobs[1]);
    expect(state.deleted_at === null).toBe(script !== 'remove_photos');
    evidence.push({ script, batch, binding, state });
  }
  await writeFile(info.outputPath('mcp-browser-handoffs.json'), JSON.stringify(evidence, null, 2));
});

test('a migration token with a missing or wrong script cannot be silently consumed', async ({ page, context }) => {
  await context.addCookies(fixtures.employeeA.cookies.map(cookie => ({ ...cookie, url: process.env.DWS_BROWSER_BASE_URL!, sameSite: 'Lax' as const })));
  const output = await handoff('migrate_photos', {});
  const url = new URL(output.handoff_url);
  for (const script of [null, 'unknown_script']) {
    if (script) url.searchParams.set('script_name', script); else url.searchParams.delete('script_name');
    await page.goto(url.toString());
    await expect(page.locator('main').getByRole('alert')).toContainText('Reopen the original handoff link');
    const row = (await fixtures.sql.query('select consumed_at from public.dws_action_handoffs where token_digest=$1', [createHash('sha256').update(url.searchParams.get('token')!).digest('hex')])).rows[0];
    expect(row.consumed_at).toBeNull();
  }
});
