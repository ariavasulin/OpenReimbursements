#!/usr/bin/env node
// Operator metadata tool. Never loads .env files or chooses canonical photos.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HELP = `Photo identity cutover (all metadata artifacts must be outside git)
  node dws-app/scripts/photo-identity-cutover.mjs --project-ref <ref> --output <report-path> [--dry-run]
  ... --mapping <approved-mapping> --execute
  ... --resume <checkpoint> --execute
  ... --rollback <before-image> --execute

Default: read-only paged preflight, including legacy databases without rollout RPCs.
Mutation modes are mutually exclusive and require all three gates closed and the
operator-installed photo write boundary. Each invocation processes at most 100
groups / 30 seconds. Re-run --resume while status is checkpointed. Re-run the
same --rollback command while status is rolling_back. No gate is ever opened.

Environment: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
The HTTPS hostname must exactly match --project-ref. No credentials are loaded
from disk. Local fixtures require DWS_TEST_ISOLATED=1 and project-ref
dws-isolated-cutover; that exception accepts loopback HTTP only.

Mapping v1: {version:1, project_ref, approved_by, approved_at, groups:[{
  digest, expected_before_image_digest, canonical_photo_id, canonical_job_id,
  approved_by, approved_at
}]}. Every approval actor must be an active administrator. Copy the authoritative
group digest from an expanded-schema dry run; do not infer canonical choices.
Report companions: <output>.checkpoint.json and <output>.before-image.json.
Rollback retains new RLS/grants and permanent path/UUID fences. After new writes
or purge it closes all gates and returns forward_fix_required (exit 2): the
operator must disable Vercel cron and forward-fix the compatible application.
`;

export function parseArgs(argv) {
  const values = {}; const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (['--help', '--dry-run', '--execute'].includes(name)) {
      if (flags.has(name)) throw new Error(`Repeated argument ${name}`);
      flags.add(name);
    } else if (['--project-ref', '--output', '--mapping', '--resume', '--rollback'].includes(name)) {
      if (values[name] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument ${name}`);
      values[name] = argv[++i];
    } else throw new Error(`Unknown argument ${name}`);
  }
  if (flags.has('--help')) return { help: true };
  if (!values['--project-ref'] || !values['--output']) throw new Error('--project-ref and --output are required');
  const modes = ['--mapping', '--resume', '--rollback'].filter(key => values[key]);
  if (modes.length > 1 || (flags.has('--execute') !== (modes.length === 1)) || (flags.has('--dry-run') && modes.length)) {
    throw new Error('Use exactly one of --mapping, --resume, --rollback with --execute, or a read-only dry run');
  }
  return { projectRef: values['--project-ref'], output: path.resolve(values['--output']),
    mode: modes[0]?.slice(2) ?? 'dry-run', input: modes.length ? path.resolve(values[modes[0]]) : null };
}

const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
function insideRepository(filename) {
  const relative = path.relative(repository, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function privatePath(filename) {
  if (insideRepository(filename)) throw new Error('Metadata reports, mappings and checkpoints must be outside git');
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(path.dirname(filename));
  if (insideRepository(parent)) throw new Error('Metadata directory resolves inside git');
  try {
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Metadata paths may not be symlinks');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.join(parent, path.basename(filename));
}
async function save(filename, data) {
  await privatePath(filename);
  const temp = `${filename}.${process.pid}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, filename);
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function read(filename) { await privatePath(filename); return JSON.parse(await fs.readFile(filename, 'utf8')); }

function connection(options) {
  const endpoint = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!endpoint || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY explicitly');
  const url = new URL(endpoint);
  const isolated = process.env.DWS_TEST_ISOLATED === '1' && options.projectRef === 'dws-isolated-cutover'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
  if (!isolated && (url.protocol !== 'https:' || url.hostname !== `${options.projectRef}.supabase.co` || url.port)) {
    throw new Error('Explicit project ref does not match the Supabase target');
  }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid Supabase origin');
  if (process.env.DWS_CUTOVER_TEST_CRASH_AFTER_COMMIT && !isolated) throw new Error('Fault injection is available only to the isolated loopback harness');
  async function request(resource, payload, timeout = 8000) {
    let response;
    try {
      response = await fetch(`${url.origin}/rest/v1/${resource}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, timeout)),
      });
      const data = await response.json();
      if (!response.ok) {
        // Only fixed SQL codes/messages are diagnostics; never echo server
        // detail/hint fields that could include photo metadata or credentials.
        const safe = typeof data.message === 'string' && /^[a-z_]+$/.test(data.message) ? data.message : data.code;
        const error = new Error(`Database request failed (${response.status}, ${safe ?? 'unknown'})`);
        error.code = data.code; throw error;
      }
      return data;
    } catch (error) {
      if (error.code) throw error;
      throw new Error('Database request failed or timed out; resume the durable checkpoint to inspect a possibly committed operation');
    }
  }
  return { isolated, request, rpc: (name, args, timeout) => request(`rpc/${name}`, args, timeout) };
}

async function preflight(api, projectRef) {
  const started = performance.now();
  let schemaReady = true;
  try { await api.rpc('photo_cutover_snapshot', { p_digest: '0'.repeat(64) }); }
  catch (error) { if (error.code === 'PGRST202') schemaReady = false; else throw error; }
  const hashes = new Map(); let cursor = ''; let photos = 0; let nulls = 0; let indexed = 0;
  // Always read another keyset page until empty: server-side page caps can be
  // smaller than our requested limit, so a short page is not proof of EOF.
  while (true) {
    const query = new URLSearchParams({ select: schemaReady ? 'id,content_sha256,legacy_content_sha256' : '*', order: 'id.asc', limit: '1000' });
    if (cursor) query.set('id', `gt.${cursor}`);
    const rows = await api.request(`photos?${query}`);
    if (!rows.length) break;
    for (const row of rows) {
      photos++;
      if (row.content_sha256 === null) { if (!row.legacy_content_sha256) nulls++; }
      else {
        indexed++;
        if (schemaReady) hashes.set(row.content_sha256, (hashes.get(row.content_sha256) ?? 0) + 1);
        else {
          const group = hashes.get(row.content_sha256) ?? [];
          group.push(row); hashes.set(row.content_sha256, group);
        }
      }
    }
    const next = rows.at(-1).id;
    if (next <= cursor) throw new Error('Photo pagination did not advance');
    cursor = next;
  }
  const groups = [];
  for (const [digest, rows] of [...hashes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if ((schemaReady ? rows : rows.length) < 2) continue;
    groups.push(schemaReady ? await api.rpc('photo_cutover_snapshot', { p_digest: digest })
      : { digest, rows, expected_before_image_digest: null });
  }
  return { version: 1, project_ref: projectRef, mode: 'dry-run', schema_ready: schemaReady,
    observed_at: new Date().toISOString(), snapshot_consistency: 'paged; repeat under closed gates before approval',
    totals: { photos, legacy_null_hashes: nulls, indexed_hashes: indexed, duplicate_groups: groups.length,
      duplicate_rows: groups.reduce((count, group) => count + group.rows.length, 0) }, groups,
    elapsed_ms: Math.round(performance.now() - started),
    next_action: schemaReady ? 'Administrator reviews explicit canonical choices; close gates/install boundary before execute'
      : 'Legacy read-only preflight; apply additive schema, then repeat dry run before approving a mapping' };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  const outputIdentity = await privatePath(options.output);
  if (options.input && await privatePath(options.input) === outputIdentity) throw new Error('Output must not overwrite its input');
  const api = connection(options);
  console.log(`Target: ${options.projectRef}; mode: ${options.mode}${options.mode === 'dry-run' ? ' (read-only)' : ' (explicit execute)'}`);
  if (options.mode === 'dry-run') {
    const report = await preflight(api, options.projectRef);
    await save(options.output, report);
    console.log(`Read-only preflight: ${report.totals.photos} rows, ${report.totals.duplicate_groups} duplicate groups; report: ${options.output}`);
    return;
  }
  const input = await read(options.input);
  if (input.version !== 1 || input.project_ref !== options.projectRef) throw new Error('Metadata version/project target mismatch');
  if (options.mode === 'rollback') {
    const result = await api.rpc('photo_cutover_rollback', { p_run_id: input.run_id, p_before_image: input }, 29000);
    await save(options.output, { version: 1, project_ref: options.projectRef, run_id: input.run_id, ...result });
    console.log(`Rollback: ${result.status}; report: ${options.output}`);
    if (result.status === 'forward_fix_required') {
      console.error('All database gates are closed. Disable Vercel cron, retain the compatible schema/app, and forward-fix.');
      process.exitCode = 2;
    }
    return;
  }
  const mapping = options.mode === 'mapping' ? input : input.mapping;
  if (!mapping || mapping.version !== 1 || mapping.project_ref !== options.projectRef || !Array.isArray(mapping.groups)) throw new Error('Invalid mapping target/version/groups');
  const beforePath = options.mode === 'resume' ? input.before_image : `${options.output}.before-image.json`;
  const checkpointPath = `${options.output}.checkpoint.json`;
  const beforeIdentity = await privatePath(beforePath);
  const checkpointIdentity = await privatePath(checkpointPath);
  const inputIdentity = await privatePath(options.input);
  if (new Set([outputIdentity, beforeIdentity, checkpointIdentity]).size !== 3
    || inputIdentity === beforeIdentity || (options.mode === 'mapping' && inputIdentity === checkpointIdentity)) {
    throw new Error('Output/recovery paths must not overwrite each other or the approved mapping');
  }
  const started = performance.now(); const deadline = started + 30000;
  const boundedRpc = (name, args) => {
    const remaining = deadline - performance.now();
    if (remaining < 1) throw new Error('Invocation budget exhausted; resume the durable checkpoint');
    return api.rpc(name, args, Math.min(8000, remaining));
  };
  const run = await boundedRpc('photo_cutover_begin', { p_mapping: mapping });
  if (options.mode === 'resume' && run.id !== input.run_id) throw new Error('Checkpoint does not match the durable run');
  const beforeImage = await boundedRpc('photo_cutover_export', { p_run_id: run.id });
  await save(beforePath, beforeImage);
  // Write and fsync recovery metadata before the first photo mutation. The DB
  // journal, not completed_digests, is authoritative on every replay.
  const checkpoint = { version: 1, project_ref: options.projectRef, run_id: run.id, mapping,
    before_image: beforePath, completed_digests: options.mode === 'resume' ? input.completed_digests ?? [] : [] };
  await save(checkpointPath, checkpoint);
  let processed = 0; let applied = 0; let replayed = 0;
  const completed = new Set(checkpoint.completed_digests);
  // Durable ledger lets a normal resume skip checkpointed groups. Finish also
  // validates every group's after-image so skipping cannot hide later drift.
  const choices = [...mapping.groups].sort((a, b) => a.digest.localeCompare(b.digest));
  for (const choice of choices) {
    if (completed.has(choice.digest)) continue;
    if (processed >= 100 || performance.now() + 1000 >= deadline) break;
    const result = await boundedRpc('photo_cutover_apply', { p_run_id: run.id, p_digest: choice.digest });
    processed++; if (result.status === 'applied') applied++; else replayed++;
    const crashAfter = Number(process.env.DWS_CUTOVER_TEST_CRASH_AFTER_COMMIT);
    if (api.isolated && Number.isSafeInteger(crashAfter) && crashAfter > 0 && processed === crashAfter) process.kill(process.pid, 'SIGKILL');
    completed.add(choice.digest); checkpoint.completed_digests = [...completed];
    await save(checkpointPath, checkpoint);
  }
  let finish = { status: 'checkpointed' };
  if (choices.every(choice => completed.has(choice.digest)) && performance.now() + 1000 < deadline) {
    finish = await boundedRpc('photo_cutover_finish', { p_run_id: run.id });
  }
  const elapsed = performance.now() - started;
  const remaining = choices.filter(choice => !completed.has(choice.digest)).length;
  await save(options.output, { version: 1, project_ref: options.projectRef, run_id: run.id, ...finish,
    processed, applied, replayed, remaining_groups: remaining, elapsed_ms: Math.round(elapsed),
    projected_remaining_ms: processed ? Math.round(remaining * elapsed / processed) : null,
    checkpoint: checkpointPath, before_image: beforePath });
  console.log(`Cutover: ${finish.status}; ${applied} applied, ${replayed} replayed, ${remaining} remaining; report: ${options.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Cutover stopped: ${error.message}`); process.exitCode = 1; });
}
