import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';
import { assertValidIndexes } from '../../scripts/test-migrations.mjs';
import { assertDatabaseIdentity } from '../../scripts/test-local-target.mjs';
import { fixtureId, GROUPS, INACTIVE_JOB, JOB_A, JOB_B, NULL_HASHES, PENDING_ATTEMPT, seedCutoverFixture } from './fixture';

const evidenceDirectory = resolve('test-results/phase7-cutover');
let output: string;
const projectRef = 'dws-isolated-cutover';
const script = resolve('scripts/photo-identity-cutover.mjs');
type Group = { digest: string; expected_before_image_digest: string; rows: Array<{ id: string; job_id: string }> };
type Report = Record<string, any>;

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env,
      DWS_TEST_ISOLATED: '1', SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

describe('actual operator CLI rollout on disposable PostgreSQL/Auth/Storage (AC-11, AC-14)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  let fixture: Awaited<ReturnType<typeof seedCutoverFixture>>;
  const evidence: Report = { target: 'disposable loopback PostgreSQL 15/Auth/Storage', scenarios: [] };
  const snapshots = () => f.sql.query('select to_jsonb(p) as row from public.photos p order by id').then(r => r.rows.map(x => x.row));
  const read = async (name: string): Promise<Report> => JSON.parse(await readFile(resolve(output, name), 'utf8'));
  const run = async (name: string, args: string[] = [], env: Record<string, string> = {}) => {
    const result = await cli(['--project-ref', projectRef, '--output', resolve(output, `${name}.json`), ...args], env);
    await writeFile(resolve(output, `${name}.process.json`), JSON.stringify(result, null, 2));
    return result;
  };

  beforeAll(async () => {
    output = await mkdtemp(resolve(tmpdir(), 'dws-cutover-fixture-'));
    f = await createFixtures();
  });
  afterAll(async () => {
    await writeFile(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    // The operator tool mandates non-git metadata paths. Only these known
    // synthetic fixtures are copied to the ignored evidence directory.
    await rm(evidenceDirectory, { recursive: true, force: true });
    await mkdir(evidenceDirectory, { recursive: true });
    await cp(output, evidenceDirectory, { recursive: true });
    await rm(output, { recursive: true, force: true });
    await f?.close();
  });

  it('prints the operator interface and rejects ambiguous mutation modes', async () => {
    const help = await cli(['--help']);
    expect(help.code, help.stderr).toBe(0);
    for (const option of ['--project-ref', '--output', '--dry-run', '--mapping', '--execute', '--resume', '--rollback']) expect(help.stdout).toContain(option);
    const both = await run('invalid-modes', ['--execute', '--resume', 'unused', '--rollback', 'unused']);
    expect(both.code).not.toBe(0);
    expect((await run('mapping-required', ['--execute'])).code).not.toBe(0);
    evidence.scenarios.push({ name: 'help and mutually exclusive modes', passed: true });
  });

  it('requires administrator approval even when the collision mapping is empty', async () => {
    expect((await f.admin.rpc('photo_install_write_boundary', { p_actor: f.administrator.id })).error).toBeNull();
    const empty = { version: 1, project_ref: projectRef, approved_by: f.administrator.id, approved_at: new Date().toISOString(), groups: [] };
    const path = resolve(output, 'empty-mapping.json');
    await writeFile(path, JSON.stringify({ ...empty, approved_by: f.employeeA.id }));
    expect((await run('empty-employee', ['--mapping', path, '--execute'])).code).not.toBe(0);
    await writeFile(path, JSON.stringify(empty));
    const applied = await run('empty-approved', ['--mapping', path, '--execute']);
    expect(applied.code, applied.stderr).toBe(0);
    expect(await read('empty-approved.json')).toMatchObject({ status: 'indexed', global_index_valid: true });
    await assertValidIndexes(f.sql);
    const rolledBack = await run('empty-rollback', ['--rollback', resolve(output, 'empty-approved.json.before-image.json'), '--execute']);
    expect(rolledBack.code, rolledBack.stderr).toBe(0);
    expect(await read('empty-rollback.json')).toMatchObject({ status: 'rolled_back' });
    evidence.scenarios.push({ name: 'zero-collision administrator approval, global index and rollback', passed: true });
  });

  it('keeps cutover ledgers and RPC execution server-only', async () => {
    for (const client of [f.anon, f.employeeA.client, f.administrator.client]) {
      for (const table of ['photo_cutover_epoch', 'photo_cutover_runs', 'photo_cutover_groups']) {
        expect((await client.from(table).select('*').limit(1)).error).not.toBeNull();
        expect((await client.from(table).insert({})).error).not.toBeNull();
      }
      expect((await client.rpc('photo_cutover_begin', { p_mapping: {} })).error).not.toBeNull();
    }
    evidence.scenarios.push({ name: 'cutover ledgers and operator RPCs denied to session clients', passed: true });
  });

  it('rehearses dry-run, reviewed cleanup, crash recovery, stale clients, and both rollback branches', async () => {
    fixture = await seedCutoverFixture(f);
    const before = await snapshots();
    const pendingBefore = (await f.sql.query('select to_jsonb(a) as row from public.photo_upload_attempts a where id=$1', [PENDING_ATTEMPT])).rows[0].row;
    const dry = await run('dry-run');
    expect(dry.code, dry.stderr).toBe(0);
    expect(await snapshots()).toEqual(before);
    const report = await read('dry-run.json');
    expect(report.groups).toHaveLength(GROUPS);
    expect(report.totals).toMatchObject({ photos: GROUPS * 2 + NULL_HASHES, legacy_null_hashes: NULL_HASHES,
      indexed_hashes: GROUPS * 2, duplicate_groups: GROUPS, duplicate_rows: GROUPS * 2 });
    // Exercise the actual legacy RPC-unavailable fallback on the same rows.
    // Renaming preserves the function's identity/ACL and is restored before any
    // execute or drift test; only this verified disposable fixture is modified.
    await assertDatabaseIdentity(f.sql);
    await f.sql.query('alter function public.photo_cutover_snapshot(text) rename to photo_cutover_snapshot_fixture_hidden');
    try {
      await f.sql.query("notify pgrst, 'reload schema'");
      await expect.poll(async () => (await f.admin.rpc('photo_cutover_snapshot', { p_digest: '0'.repeat(64) })).error?.code,
        { timeout: 10_000 }).toBe('PGRST202');
      const legacy = await run('legacy-dry-run');
      expect(legacy.code, legacy.stderr).toBe(0);
      const legacyReport = await read('legacy-dry-run.json');
      expect(Object.keys(legacyReport).sort()).toEqual(Object.keys(report).sort());
      expect(legacyReport.schema_ready).toBe(false);
      expect(report.schema_ready).toBe(true);
      expect(legacyReport.totals).toEqual(report.totals);
      expect(legacyReport.groups).toEqual(report.groups.map((group: Group) => ({ ...group, expected_before_image_digest: null })));
      expect(report.groups.every((group: Group) => /^[0-9a-f]{64}$/.test(group.expected_before_image_digest))).toBe(true);
      expect(await snapshots()).toEqual(before);
      evidence.scenarios.push({ name: 'legacy fallback and narrowed expanded dry-run preserve totals/full group rows and report shape', passed: true });
    } finally {
      await f.sql.query('alter function public.photo_cutover_snapshot_fixture_hidden(text) rename to photo_cutover_snapshot');
      await f.sql.query("notify pgrst, 'reload schema'");
      await expect.poll(async () => (await f.admin.rpc('photo_cutover_snapshot', { p_digest: '0'.repeat(64) })).error,
        { timeout: 10_000 }).toBeNull();
    }
    const mapping = { version: 1, project_ref: projectRef, approved_by: f.administrator.id, approved_at: new Date().toISOString(), groups: (report.groups as Group[]).map(group => ({
      digest: group.digest, expected_before_image_digest: group.expected_before_image_digest,
      canonical_photo_id: group.rows.find(row => row.job_id !== JOB_B)!.id,
      canonical_job_id: group.rows.find(row => row.job_id !== JOB_B)!.job_id,
      approved_by: f.administrator.id, approved_at: new Date().toISOString(),
    })) };
    const mappingPath = resolve(output, 'approved-mapping.json');
    await writeFile(mappingPath, JSON.stringify(mapping, null, 2));
    evidence.before = { photos: before.length, collisions: GROUPS, null_hashes: NULL_HASHES };
    evidence.scenarios.push({ name: 'default dry-run preserves every photo field', passed: true });

    // A reviewed mapping is not authority until the actor and write boundary
    // are validated. No rejected invocation may change a photo.
    const employeePath = resolve(output, 'employee-mapping.json');
    await writeFile(employeePath, JSON.stringify({ ...mapping, groups: mapping.groups.map(group => ({ ...group, approved_by: f.employeeA.id })) }));
    expect((await run('employee-denied', ['--mapping', employeePath, '--execute'])).code).not.toBe(0);
    expect(await snapshots()).toEqual(before);
    expect((await f.admin.rpc('photo_install_write_boundary', { p_actor: f.administrator.id })).error).toBeNull();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true where singleton');
    expect((await run('open-gate-denied', ['--mapping', mappingPath, '--execute'])).code).not.toBe(0);
    expect(await snapshots()).toEqual(before);
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=false where singleton');

    const mismatchPath = resolve(output, 'mismatched-job-mapping.json');
    await writeFile(mismatchPath, JSON.stringify({ ...mapping, groups: mapping.groups.map((group, index) =>
      index === 0 ? { ...group, canonical_job_id: JOB_B } : group) }));
    const mismatch = await run('mismatched-job-denied', ['--mapping', mismatchPath, '--execute']);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain('cutover_group_drift');
    expect(await snapshots()).toEqual(before);
    const mismatchRollback = await run('mismatched-job-rollback', ['--rollback', resolve(output, 'mismatched-job-denied.json.before-image.json'), '--execute']);
    expect(mismatchRollback.code, mismatchRollback.stderr).toBe(0);

    const driftId = mapping.groups[0].canonical_photo_id;
    await f.sql.query("update public.photos set original_path=original_path||'.changed' where id=$1", [driftId]);
    const drifted = await snapshots();
    const drift = await run('drift-denied', ['--mapping', mappingPath, '--execute']);
    expect(drift.code).not.toBe(0);
    expect(await snapshots()).toEqual(drifted);
    const abandonDrift = await run('drift-rollback', ['--rollback', resolve(output, 'drift-denied.json.before-image.json'), '--execute']);
    expect(abandonDrift.code, abandonDrift.stderr).toBe(0);
    await f.sql.query('update public.photos set original_path=$2 where id=$1', [driftId, before.find(row => row.id === driftId).original_path]);
    evidence.scenarios.push({ name: 'employee, open-gate, and before-image drift rejected without cleanup', passed: true });

    const crashed = await run('crash', ['--mapping', mappingPath, '--execute'], { DWS_CUTOVER_TEST_CRASH_AFTER_COMMIT: '1' });
    expect(crashed.code).not.toBe(0);
    expect((await snapshots()).filter(row => row.duplicate_of)).toHaveLength(1);
    const resumed = await run('resume', ['--resume', resolve(output, 'crash.json.checkpoint.json'), '--execute']);
    expect(resumed.code, resumed.stderr).toBe(0);
    const resumeReport = await read('resume.json');
    expect(resumeReport.processed).toBeLessThanOrEqual(100);
    expect(resumeReport.replayed).toBe(1);
    expect(resumeReport.elapsed_ms).toBeLessThan(30_000);
    expect(resumeReport.projected_remaining_ms).toBeGreaterThanOrEqual(0);
    // The database determines committed progress, including the group committed
    // immediately before process death lost its local checkpoint write.
    const firstPage = (await snapshots()).filter(row => row.duplicate_of).length;
    expect(firstPage).toBeGreaterThan(1);
    expect(firstPage).toBeLessThanOrEqual(101);
    expect(firstPage).toBeLessThan(GROUPS);
    const completed = await run('complete', ['--resume', resolve(output, 'resume.json.checkpoint.json'), '--execute']);
    expect(completed.code, completed.stderr).toBe(0);
    const after = await snapshots();
    expect(after).toHaveLength(before.length);
    expect(after.filter(row => row.duplicate_of)).toHaveLength(GROUPS);
    expect(after.filter(row => row.content_sha256 === null && row.legacy_content_sha256 === null)).toHaveLength(NULL_HASHES);
    expect(after.find(row => row.id === fixtureId(100))).toMatchObject({ job_id: INACTIVE_JOB, deleted_at: null, duplicate_of: null });
    expect((await f.sql.query('select is_active from public.jobs where id=$1', [INACTIVE_JOB])).rows[0].is_active).toBe(false);
    for (const group of mapping.groups) {
      const canonical = after.find(row => row.id === group.canonical_photo_id);
      expect(canonical).toMatchObject({ job_id: group.canonical_job_id, content_sha256: group.digest, deleted_at: null, duplicate_of: null });
      const duplicate = after.find(row => row.duplicate_of === canonical.id);
      expect(duplicate).toMatchObject({ content_sha256: null, legacy_content_sha256: group.digest, deleted_by: f.administrator.id });
      expect(Date.parse(duplicate.purge_after) - Date.parse(duplicate.deleted_at)).toBe(30 * 86_400_000);
      const original = before.find(row => row.id === duplicate.id);
      for (const key of ['job_id', 'original_path', 'thumb_path', 'original_name', 'original_bytes', 'captured_at', 'tags']) expect(duplicate[key]).toEqual(original[key]);
    }
    expect((await f.sql.query('select content_sha256 from public.photos where content_sha256 is not null group by content_sha256 having count(*)>1')).rows).toEqual([]);
    await assertValidIndexes(f.sql);
    const globalIndex = (await f.sql.query("select indexdef from pg_indexes where schemaname='public' and tablename='photos' and indexdef like '%UNIQUE%' and indexdef like '%(content_sha256)%'")).rows;
    expect(globalIndex).toHaveLength(1);
    const replay = await run('replay', ['--mapping', mappingPath, '--execute']);
    expect(replay.code, replay.stderr).toBe(0);
    expect(await snapshots()).toEqual(after);
    expect((await f.sql.query('select to_jsonb(a) as row from public.photo_upload_attempts a where id=$1', [PENDING_ATTEMPT])).rows[0].row).toEqual(pendingBefore);
    expect((await f.admin.storage.from('photos').download(fixture.originalPath)).error).toBeNull();
    for (const path of fixture.retainedObjects) {
      const bytes = await f.admin.storage.from('photos').download(path);
      expect(bytes.error).toBeNull();
      expect(Buffer.from(await bytes.data!.arrayBuffer())).toEqual(Buffer.from([5, 6, 7, 8]));
    }
    evidence.after = { photos: after.length, duplicate_history: GROUPS, null_hashes: NULL_HASHES, global_index: globalIndex[0].indexdef, first_resume_total: firstPage };
    evidence.timing = { dry_run_ms: report.elapsed_ms, first_page: resumeReport,
      interpretation: 'Observed isolated metadata-only duration; not a production outage guarantee' };
    evidence.scenarios.push({ name: 'crash after commit, bounded resume, valid index, replay and interrupted Storage preservation', passed: true });
    evidence.scenarios.push({ name: 'existing inactive owning job preserved; arbitrary canonical destination rejected', passed: true });

    for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
      const oldSelect = await actor.client.from('photos').select('id,uploader:user_profiles(full_name),job:jobs(id,job_number,name),tags');
      expect(oldSelect.error).toBeNull();
      expect(oldSelect.data).toHaveLength(GROUPS + NULL_HASHES);
      expect(JSON.stringify(oldSelect.data)).not.toContain('legacy-noncanonical-only');
      const summaries = await actor.client.rpc('get_photo_job_summaries', { search_query: 'cutover-fixture-' });
      expect(summaries.error).toBeNull();
      // The existing summary RPC excludes inactive jobs as well as trashed photos.
      expect(summaries.data.reduce((n: number, row: { photo_count: number }) => n + Number(row.photo_count), 0)).toBe(GROUPS + NULL_HASHES - 1);
      const tags = await actor.client.rpc('get_photo_tags', { job_filter: JOB_B, q: null });
      expect(tags.error).toBeNull();
      expect(tags.data).toEqual([]);
      expect((await actor.client.from('photos').delete().eq('id', mapping.groups[0].canonical_photo_id)).error).not.toBeNull();
      expect((await actor.client.from('photos').insert({ id: fixtureId(2000), job_id: JOB_A, uploader_id: actor.id, kind: 'image', original_path: 'stale-unhashed.jpg' })).error).not.toBeNull();
    }
    expect(await snapshots()).toEqual(after);
    evidence.scenarios.push({ name: 'old unfiltered SELECT/embedding/RPC hides trash; old hard Delete and unhashed Insert denied', passed: true });

    const rollback = await run('rollback', ['--rollback', resolve(output, 'crash.json.before-image.json'), '--execute']);
    expect(rollback.code, rollback.stderr).toBe(0);
    expect(await read('rollback.json')).toMatchObject({ status: 'rolling_back', restored: 100 });
    const finishRollback = await run('rollback-complete', ['--rollback', resolve(output, 'crash.json.before-image.json'), '--execute']);
    expect(finishRollback.code, finishRollback.stderr).toBe(0);
    expect(await snapshots()).toEqual(before);
    for (const path of fixture.retainedObjects) {
      const bytes = await f.admin.storage.from('photos').download(path);
      expect(bytes.error).toBeNull();
      expect(Buffer.from(await bytes.data!.arrayBuffer())).toEqual(Buffer.from([5, 6, 7, 8]));
    }
    await assertValidIndexes(f.sql);
    evidence.scenarios.push({ name: 'pre-write rollback restores exact original photos', passed: true });

    const second = await run('second-execute', ['--mapping', mappingPath, '--execute']);
    expect(second.code, second.stderr).toBe(0);
    const secondComplete = await run('second-complete', ['--resume', resolve(output, 'second-execute.json.checkpoint.json'), '--execute']);
    expect(secondComplete.code, secondComplete.stderr).toBe(0);
    expect((await snapshots()).filter(row => row.duplicate_of)).toHaveLength(GROUPS);
    const epoch = async () => Number((await f.sql.query('select generation from public.photo_cutover_epoch where singleton')).rows[0].generation);
    const beforeWriteEpoch = await epoch();
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=true where singleton');
    const newWrite = await f.employeeA.client.from('photos').update({ tags: ['post-cutover-user-edit'] }).eq('id', driftId).select('id');
    expect(newWrite.error).toBeNull();
    expect(newWrite.data).toEqual([{ id: driftId }]);
    expect(await epoch()).toBeGreaterThan(beforeWriteEpoch);
    await f.sql.query('update public.photo_release_state set photo_writes_enabled=false where singleton');
    const afterWrite = await snapshots();
    const changedReplay = await run('applied-drift-denied', ['--mapping', mappingPath, '--execute']);
    expect(changedReplay.code).not.toBe(0);
    expect(await snapshots()).toEqual(afterWrite);
    const refused = await run('new-write-rollback-refused', ['--rollback', resolve(output, 'second-execute.json.before-image.json'), '--execute']);
    expect(refused.code).toBe(2);
    expect(await read('new-write-rollback-refused.json')).toMatchObject({ status: 'forward_fix_required', gates_closed: true, disable_vercel_cron: true });
    expect(await snapshots()).toEqual(afterWrite);
    expect((await f.sql.query('select photo_writes_enabled,mcp_enabled,repair_enabled from public.photo_release_state where singleton')).rows[0])
      .toEqual({ photo_writes_enabled: false, mcp_enabled: false, repair_enabled: false });
    await assertValidIndexes(f.sql);
    evidence.scenarios.push({ name: 'applied-group drift fails closed; new employee writes force retained-schema forward fix', passed: true });

    // Exercise the real deletion authorization boundary. Authorization itself
    // is irreversible history, even if a worker dies before deleting bytes.
    const beforePurgeEpoch = await epoch();
    await f.sql.query('update public.photo_release_state set repair_enabled=true where singleton');
    const holder = fixtureId(3000);
    const acquired = await f.admin.rpc('photo_repair_acquire', { p_holder: holder });
    expect(acquired.error).toBeNull();
    const generation = acquired.data.lease_generation;
    const orphanPath = `originals/${f.employeeA.id}/${fixtureId(3001)}/orphan.jpg`;
    const authorization = await f.admin.rpc('photo_repair_authorize_delete', {
      p_holder: holder, p_generation: generation, p_path: orphanPath, p_photo_id: null,
    });
    expect(authorization.error).toBeNull();
    expect((await f.sql.query('select path from public.photo_repair_deleted_paths where path=$1', [orphanPath])).rows).toHaveLength(1);
    expect(await epoch()).toBeGreaterThan(beforePurgeEpoch);
    const purgeRefused = await run('purge-rollback-refused', ['--rollback', resolve(output, 'second-execute.json.before-image.json'), '--execute']);
    expect(purgeRefused.code).toBe(2);
    expect(await read('purge-rollback-refused.json')).toMatchObject({ status: 'forward_fix_required', gates_closed: true, disable_vercel_cron: true });
    expect(await snapshots()).toEqual(afterWrite);
    expect((await f.sql.query('select path from public.photo_repair_deleted_paths where path=$1', [orphanPath])).rows).toHaveLength(1);
    evidence.scenarios.push({ name: 'deletion authorization advances rollback fence; refusal preserves photos and permanent fence', passed: true });
    evidence.repair = { implementation: 'current photo_repair_* SQL; no old service-role handler invoked', authorization: authorization.data };
  }, 180_000);

  it('refuses rollback when deletion authorization alone changes a fresh run epoch', async () => {
    await assertDatabaseIdentity(f.sql);
    const photosBefore = await snapshots();
    const fencesBefore = (await f.sql.query('select to_jsonb(p) as row from public.photo_repair_deleted_paths p order by path')).rows.map(row => row.row);
    // Reset only this disposable rehearsal's operator journals, to begin an
    // independent run after the new-write scenario. Retain every photo, epoch
    // and permanent fence; production operators must never reset these ledgers.
    await f.sql.query('delete from public.photo_cutover_groups');
    await f.sql.query('delete from public.photo_cutover_runs');
    await f.sql.query('update public.photo_repair_progress set lease_holder=null,lease_expires_at=null where singleton');
    const cleanMapping = { version: 1, project_ref: projectRef, approved_by: f.administrator.id,
      approved_at: new Date().toISOString(), groups: [] };
    const cleanMappingPath = resolve(output, 'purge-only-mapping.json');
    await writeFile(cleanMappingPath, JSON.stringify(cleanMapping));
    const clean = await run('purge-only-clean-run', ['--mapping', cleanMappingPath, '--execute']);
    expect(clean.code, clean.stderr).toBe(0);
    const cleanReport = await read('purge-only-clean-run.json');
    expect(cleanReport).toMatchObject({ status: 'indexed', global_index_valid: true });
    const epoch = async () => Number((await f.sql.query('select generation from public.photo_cutover_epoch where singleton')).rows[0].generation);
    const baselineEpoch = await epoch();
    expect(Number((await f.sql.query('select generation from public.photo_cutover_runs where id=$1', [cleanReport.run_id])).rows[0].generation)).toBe(baselineEpoch);
    expect(await snapshots()).toEqual(photosBefore);

    await f.sql.query('update public.photo_release_state set repair_enabled=true where singleton');
    const holder = fixtureId(4000);
    const acquired = await f.admin.rpc('photo_repair_acquire', { p_holder: holder });
    expect(acquired.error).toBeNull();
    const orphanPath = `originals/${f.employeeA.id}/${fixtureId(4001)}/purge-only.jpg`;
    expect((await f.sql.query('select path from public.photo_repair_deleted_paths where path=$1', [orphanPath])).rows).toEqual([]);
    const authorized = await f.admin.rpc('photo_repair_authorize_delete', {
      p_holder: holder, p_generation: acquired.data.lease_generation, p_path: orphanPath, p_photo_id: null,
    });
    expect(authorized.error).toBeNull();
    expect(authorized.data).toBe(true);
    expect(await epoch()).toBe(baselineEpoch + 1);
    expect(await snapshots()).toEqual(photosBefore);

    const refused = await run('purge-only-rollback-refused', ['--rollback', resolve(output, 'purge-only-clean-run.json.before-image.json'), '--execute']);
    expect(refused.code).toBe(2);
    expect(await read('purge-only-rollback-refused.json')).toMatchObject({ status: 'forward_fix_required',
      reason: 'new_writes_or_purge', gates_closed: true, disable_vercel_cron: true });
    expect((await f.sql.query('select photo_writes_enabled,mcp_enabled,repair_enabled from public.photo_release_state where singleton')).rows[0])
      .toEqual({ photo_writes_enabled: false, mcp_enabled: false, repair_enabled: false });
    expect(await snapshots()).toEqual(photosBefore);
    const fencesAfter = (await f.sql.query('select to_jsonb(p) as row from public.photo_repair_deleted_paths p order by path')).rows.map(row => row.row);
    expect(fencesAfter.filter(row => row.path !== orphanPath)).toEqual(fencesBefore);
    expect(fencesAfter.filter(row => row.path === orphanPath)).toHaveLength(1);
    expect(await epoch()).toBe(baselineEpoch + 1);
    await assertValidIndexes(f.sql);
    evidence.purge_only = { run_epoch: baselineEpoch, authorization_epoch: baselineEpoch + 1,
      photo_writes_after_run: 0, photos_preserved: photosBefore.length,
      prior_fences_preserved: fencesBefore.length, new_fences_preserved: 1,
      rollback: await read('purge-only-rollback-refused.json') };
    evidence.scenarios.push({ name: 'independent clean run: deletion authorization alone forces closed-gate rollback refusal and retains all fences', passed: true });
  });
});
