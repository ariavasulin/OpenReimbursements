// Review stack: a throwaway local DWS Photos that a person (or a reviewing model) can sign in to.
//
//   npm run review:stack -- [--dev] [--migrations-through <YYYYMMDDHHMMSS>]
//                           [--seed-dir <dir>] [--info-file <path>]
//
// It boots a disposable local Supabase with the same production-safety guards as
// scripts/test-integration.mjs, replays the repository migrations, seeds realistic people,
// projects, photos and albums, serves the app from a source snapshot, prints how to sign in, and
// stays up until it is stopped. Sign in on the real login page with +1 555 555 0199, code 4321.
// Ctrl-C (or SIGTERM) stops Next, removes the Supabase containers and deletes the temporary workdir.
//
// test-integration.mjs keeps its boot logic inline and must not change while suites are running,
// so the blocks marked "Duplicated from test-integration.mjs" are copies. Everything that file's
// helpers DO export (the local-target guards and the migration replayer) is imported, not copied.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { assertDatabaseIdentity, assertLocalTestTarget } from './test-local-target.mjs';
import { migrationDirectory, replayMigrations } from './test-migrations.mjs';

const app = resolve(import.meta.dirname, '..');
const defaultSeedDir = resolve(app, '../.artifacts/photo-albums/review-seed');

// The login page only accepts 4-digit codes, and the harness numbers in integration/supabase.toml
// use 6 digits, so the reviewer gets a test number of their own. Test numbers never send an SMS.
const REVIEWER_PHONE = '15555550199';
const REVIEWER_CODE = '4321';
const REVIEWER_PHONE_DISPLAY = '+1 555 555 0199';
const PEOPLE = [
  { key: 'reviewer', phone: REVIEWER_PHONE, fullName: 'Jordan Whitfield', role: 'employee' },
  { key: 'colleague', phone: '15555550198', fullName: 'Maya Okafor', role: 'employee' },
  { key: 'admin', phone: '15555550197', fullName: 'Dana Reyes', role: 'admin' },
];
// The first four receive photos (index = position). `handMade` gets a generated P-<n> code, the
// way a project created in the app does. Two names are 60+ characters to show how long ones wrap.
const PROJECTS = [
  { key: 'harborview', jobNumber: '3647', location: 'Level 12, 80 Harbour Street',
    name: 'Harborview Tower Level 12 Office Fit-Out – Reception, Boardroom and Steel-Framed Glass Partitions' },
  { key: 'eastside', jobNumber: '3612', location: 'Eastside Technology Park', name: 'Eastside Tech Campus – Reception Desk & Feature Wall' },
  { key: 'cafe', jobNumber: '3701', location: '14 Alder Lane', name: 'Alder & Ash Café – Banquette Seating and Timber Ceiling' },
  { key: 'shop', handMade: true, location: null, name: 'Shop Samples & Mockups' },
  { key: 'riverside', jobNumber: '3688', location: 'Riverside Medical Centre',
    name: 'Riverside Medical Centre Outpatient Wing – Nurse Stations, Casework and Wall Panelling Package' },
  { key: 'townhouses', jobNumber: '3725', location: 'Wilson Street', name: 'Wilson Street Townhouses – Kitchens' },
  { key: 'library', jobNumber: '3540', location: 'Monroe Public Library', name: 'Monroe Library Reading Room Refurbishment' },
  { key: 'bar', jobNumber: '3759', location: '3 Quay Street', name: 'Quay Street Bar Fit-Out' },
];
const PHOTO_PROJECTS = 4;
const TAG_SETS = [['professional'], ['shop drawing'], ['field dimension'], ['professional', 'field dimension']];
const THUMB_PX = 400;
const PREVIEW_PX = 1600;
const IMAGE_TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const usage = `Usage: node scripts/review-stack.mjs [options]
  --dev                           run "next dev" instead of "next build" + "next start"
  --migrations-through <stamp>    apply only migrations whose 14-digit timestamp is <= <stamp>
                                  (baseline files always apply)
  --seed-dir <dir>                photos to seed (default: <repo>/.artifacts/photo-albums/review-seed)
  --info-file <path>              also write the ready JSON here (removed again on shutdown)`;

function parseArgs(argv) {
  const options = { dev: false, migrationsThrough: null, seedDir: defaultSeedDir, infoFile: null };
  const args = argv.flatMap(arg => (arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg]));
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const value = () => {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value\n${usage}`);
      return args[++i];
    };
    if (name === '--help' || name === '-h') { console.log(usage); process.exit(0); }
    else if (name === '--dev') options.dev = true;
    else if (name === '--migrations-through') options.migrationsThrough = value();
    else if (name === '--seed-dir') options.seedDir = resolve(value());
    else if (name === '--info-file') options.infoFile = resolve(value());
    else throw new Error(`Unknown option ${name}\n${usage}`);
  }
  if (options.migrationsThrough !== null && !/^\d{14}$/.test(options.migrationsThrough)) {
    throw new Error('--migrations-through takes the 14 leading digits of a migration file name, e.g. 20260920235021');
  }
  return options;
}
let options;
try { options = parseArgs(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }

// ---- Process plumbing ------------------------------------------------------------------------

const project = `dws-test-${randomBytes(6).toString('hex')}`; // the shape assertLocalTestTarget accepts
const workdir = await mkdtemp(resolve(tmpdir(), `${project}-`));
// Duplicated from test-integration.mjs. Allowlist system plumbing only: neither the parent's app
// secrets, nor an inherited SUPABASE_ACCESS_TOKEN, nor .env.local ever reaches a child process.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'LANG', 'TERM'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.CI = '1';
env.NODE_ENV = 'test';
env.DWS_TEST_PROJECT = project;

class Interrupted extends Error {}
let shuttingDown = false; // set by a stop signal, by Next dying, and by the cleanup itself
let signalled = false;
let activeChild;
let wake;
const stopRequested = new Promise(resolveStop => { wake = resolveStop; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  if (shuttingDown) { console.log(`${signal} ignored: already cleaning up`); return; }
  shuttingDown = signalled = true;
  console.log(`\n${signal} received: stopping the review stack`);
  if (activeChild) killChild(activeChild);
  wake();
});
const checkpoint = () => { if (shuttingDown) throw new Interrupted(); };
// A crash must not skip the cleanup and leave five containers behind: route it into the same stop.
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
  console.error(error);
  process.exitCode = 1;
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeChild) killChild(activeChild);
  wake();
});

// A detached child leads its own process group: signalling the group also stops Next's workers,
// and the terminal's Ctrl-C never reaches it (which lets cleanup commands survive a second Ctrl-C).
const groupLeaders = new WeakSet();
function killChild(child, signal = 'SIGTERM') {
  try { if (groupLeaders.has(child)) process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// Duplicated from test-integration.mjs (`run`), always capturing output, plus `detached`.
function run(command, args, { detached = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: app, env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    if (detached) groupLeaders.add(child);
    if (!shuttingDown) activeChild = child;
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (activeChild === child) activeChild = undefined;
      code === 0 ? resolveRun(stdout) : reject(new Error(`${command} ${args[0]} failed (${code})\n${stderr || stdout}`));
    });
  });
}
// Always --workdir: the CLI can only ever address the stack generated in this temp directory.
// There is deliberately no --linked or --project-ref anywhere in this file.
const cli = (...args) => run('supabase', [...args, '--workdir', workdir], { detached: shuttingDown });
// Duplicated from test-integration.mjs.
async function freePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort); });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

// ---- Schema helpers ----------------------------------------------------------------------------

const log = message => console.log(`[review-stack] ${message}`);
const warnings = [];
function warnLoudly(message) {
  warnings.push(message);
  console.warn(`\n${'!'.repeat(88)}\n[review-stack] WARNING: ${message}\n${'!'.repeat(88)}\n`);
}
/** Column name -> { nullable }, read from information_schema so one script fits every schema stage. */
async function columnsOf(sql, table) {
  const { rows } = await sql.query("select column_name, is_nullable='YES' as nullable from information_schema.columns where table_schema='public' and table_name=$1", [table]);
  return new Map(rows.map(row => [row.column_name, row]));
}
/** Insert only the columns this database has. Safe to repeat: an existing row is left alone. */
async function insertRow(sql, table, columns, values) {
  const names = Object.keys(values).filter(name => columns.has(name) && values[name] !== undefined);
  const text = `insert into public.${table} (${names.map(name => `"${name}"`).join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')}) on conflict do nothing`;
  return (await sql.query(text, names.map(name => values[name]))).rowCount;
}
/** A stable id per seed key, so running the seed twice addresses the same rows and objects. */
function seedUuid(key) {
  const hex = createHash('sha256').update(`dws-review-stack:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Newest file first is what `--migrations-through` cuts off; baseline files (00000000…) always apply. */
async function migrationBound(requested) {
  if (requested === null) return { through: undefined, skipped: [] };
  const files = (await readdir(migrationDirectory)).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort();
  const newestBaseline = files.filter(name => name.startsWith('00000000')).at(-1)?.slice(0, 14) ?? '';
  const stamp = requested > newestBaseline ? requested : newestBaseline;
  // replayMigrations compares whole file names, so extend the stamp past any "_name.sql" suffix.
  return { through: `${stamp}_￿`, skipped: files.filter(name => name.slice(0, 14) > stamp) };
}

/**
 * The production-like end state, reached the way integration/db/authority.test.ts reaches it:
 * with every gate closed an administrator installs the write boundary through the service role,
 * then the gates open. The browser specs' content-hash index stands in for the identity cutover.
 */
async function reachEndState(sql, admin, administratorId) {
  if ((await columnsOf(sql, 'photos')).has('content_sha256')) {
    // Production got this index from the operator's identity cutover; uploads need it as their arbiter.
    await sql.query('create unique index if not exists photos_content_sha256 on public.photos(content_sha256) where content_sha256 is not null');
  }
  const gates = await columnsOf(sql, 'photo_release_state');
  if (!gates.size) return warnLoudly('No photo_release_state table at this migration stage: gates and write boundary skipped.');
  await sql.query('insert into public.photo_release_state(singleton) values(true) on conflict do nothing');
  await sql.query('update public.photo_release_state set photo_writes_enabled=false, mcp_enabled=false, repair_enabled=false where singleton');
  if ((await sql.query("select to_regprocedure('public.photo_install_write_boundary(uuid)') as fn")).rows[0].fn) {
    // PostgREST reloads its schema cache asynchronously after the replay; PGRST202 means "not yet".
    for (let attempt = 0; ; attempt++) {
      const installed = await admin.rpc('photo_install_write_boundary', { p_actor: administratorId });
      if (!installed.error) break;
      if (installed.error.code !== 'PGRST202' || attempt === 40) throw new Error(`Cannot install the write boundary: ${installed.error.message}`);
      await delay(500);
    }
    log('Installed the photo write boundary');
  } else warnLoudly('No photo_install_write_boundary() at this migration stage: write boundary skipped.');
  const open = ['photo_writes_enabled=true', 'mcp_enabled=true', 'repair_enabled=false'];
  if (gates.has('sharing_enabled')) open.push('sharing_enabled=true');
  await sql.query(`update public.photo_release_state set ${open.join(', ')} where singleton`);
  log(`Gates: ${open.join(', ')}`);
}

// ---- Seed photos -------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}
/** A plain two-tone PNG made with zlib only, so placeholders need no image library. */
function placeholderPng(index, width = 960, height = 720) {
  const top = [[196, 164, 132], [120, 144, 156], [161, 136, 127], [144, 164, 174], [188, 170, 164], [109, 135, 100]][index % 6];
  const panelLeft = Math.floor(width * 0.1) + (index * 37) % Math.floor(width * 0.4); // differs per image, so every hash differs
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height); // each row starts with filter byte 0
  for (let y = 0; y < height; y++) {
    const shade = 1 - 0.55 * (y / height);
    const inPanelRows = y > height * 0.25 && y < height * 0.75;
    for (let x = 0; x < width; x++) {
      const lift = inPanelRows && x > panelLeft && x < panelLeft + width * 0.4 ? 40 : 0;
      for (let c = 0; c < 3; c++) raw[y * stride + 1 + x * 3 + c] = Math.min(255, top[c] * shade + lift);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Photos from the seed directory (dated by manifest.tsv), or generated placeholders without one. */
async function loadSeedPhotos(seedDir) {
  let names = [];
  try { names = (await readdir(seedDir)).filter(name => IMAGE_TYPES[extname(name).toLowerCase()]).sort(); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  if (!names.length) {
    warnLoudly(`No images in ${seedDir}. Seeding 24 GENERATED PLACEHOLDER images instead of realistic photos; pass --seed-dir to fix.`);
    // Same shape as the real set: a December 2015 group for the party album, then a few job days.
    const days = [['2015-12-17', 3], ['2016-01-28', 2], ['2016-04-22', 5], ['2016-04-26', 2], ['2016-06-08', 8], ['2026-08-23', 4]];
    return days.flatMap(([day, count], group) => Array.from({ length: count }, (_, i) => {
      const index = group * 10 + i;
      return { key: `placeholder-${index}`, name: `IMG_${4000 + index}.png`, mime: 'image/png', bytes: placeholderPng(index),
        capturedAt: `${day}T${String(9 + i).padStart(2, '0')}:15:00Z`, capturedAtSource: 'file' };
    }));
  }
  // manifest.tsv: original name <tab> source id <tab> captured_at. Files here were re-encoded, so match on the base name.
  const manifest = new Map();
  try {
    for (const line of (await readFile(resolve(seedDir, 'manifest.tsv'), 'utf8')).split('\n')) {
      const [originalName, sourceId, capturedAt] = line.split('\t').map(cell => cell?.trim());
      if (originalName && capturedAt && !Number.isNaN(Date.parse(capturedAt))) manifest.set(originalName.replace(/\.[^.]+$/, '').toLowerCase(), { sourceId, capturedAt: new Date(capturedAt).toISOString() });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!manifest.size) warnLoudly(`No usable manifest.tsv in ${seedDir}: capture dates fall back to file times.`);
  return Promise.all(names.map(async name => {
    const path = resolve(seedDir, name);
    const row = manifest.get(name.replace(/\.[^.]+$/, '').toLowerCase());
    return { key: row?.sourceId || name, name, mime: IMAGE_TYPES[extname(name).toLowerCase()], bytes: await readFile(path),
      capturedAt: row?.capturedAt ?? (await stat(path)).mtime.toISOString(), capturedAtSource: row ? 'exif' : 'file' };
  }));
}

/**
 * Decide where every photo goes. Photos taken on the same day stay together: the biggest day goes
 * first, each to whichever of the four photo projects holds the fewest so far.
 */
function planPhotos(photos, { projectOptional }) {
  const sorted = [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.name.localeCompare(b.name));
  let party = sorted.filter(photo => photo.capturedAt.startsWith('2015-12'));
  if (!party.length) party = sorted.slice(0, Math.min(3, sorted.length));
  const days = new Map();
  for (const photo of sorted.filter(photo => !party.includes(photo))) {
    const day = photo.capturedAt.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), photo]);
  }
  const load = Array(PHOTO_PROJECTS).fill(0);
  for (const group of [...days.values()].sort((a, b) => b.length - a.length)) {
    const emptiest = load.indexOf(Math.min(...load));
    for (const photo of group) photo.project = emptiest;
    load[emptiest] += group.length;
  }
  // The party has no job. Before the project became optional it needs the hand-made project.
  const handMade = PROJECTS.findIndex(entry => entry.handMade);
  for (const photo of party) { photo.party = true; photo.project = projectOptional ? null : handMade; }
  if (projectOptional) {
    // About six photos with no project: the party's three plus three more from the fullest project.
    const fullest = load.indexOf(Math.max(...load));
    for (const photo of sorted.filter(entry => entry.project === fullest).slice(-3)) photo.project = null;
  }
  sorted.forEach((photo, index) => {
    photo.id = seedUuid(`photo:${photo.key}`);
    photo.uploader = index % 2 === 0 ? 'reviewer' : 'colleague';
    photo.tags = index % 3 === 1 ? TAG_SETS[Math.floor(index / 3) % TAG_SETS.length] : [];
  });
  return sorted;
}

async function seed(sql, admin, people, seedDir) {
  const counts = {};
  // ---- Projects ----
  const jobColumns = await columnsOf(sql, 'jobs');
  const hasCodeSequence = (await sql.query("select to_regclass('public.job_project_code_seq') as seq")).rows[0].seq !== null;
  const projectIds = [];
  for (const entry of PROJECTS) {
    const id = seedUuid(`project:${entry.key}`);
    projectIds.push(id);
    if ((await sql.query('select 1 from public.jobs where id=$1', [id])).rowCount) continue;
    // A hand-made project takes its P-<n> code from the app's own sequence, so the next project
    // somebody creates in the UI cannot collide with this one.
    const jobNumber = !entry.handMade ? entry.jobNumber
      : hasCodeSequence ? `P-${(await sql.query("select nextval('public.job_project_code_seq') as n")).rows[0].n}` : 'P-1';
    await insertRow(sql, 'jobs', jobColumns, { id, job_number: jobNumber, name: entry.name, location: entry.location, is_active: true,
      created_by: entry.handMade ? people.reviewer : undefined });
  }
  // ---- Photos ----
  const bucket = await admin.storage.getBucket('photos');
  if (bucket.error || !bucket.data.public) throw new Error('The public "photos" bucket is missing: --migrations-through is earlier than the migration that creates it');
  const photoColumns = await columnsOf(sql, 'photos');
  const projectOptional = photoColumns.get('job_id')?.nullable === true;
  const photos = planPhotos(await loadSeedPhotos(seedDir), { projectOptional });
  let sharp = null;
  try { sharp = (await import('sharp')).default; }
  catch { warnLoudly('sharp did not resolve from dws-app/node_modules: thumbnails and previews reuse the original bytes.'); }
  const scaled = (bytes, max) => sharp(bytes).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const put = async (path, bytes, contentType) => {
    const uploaded = await admin.storage.from('photos').upload(path, bytes, { contentType, upsert: true });
    if (uploaded.error) throw new Error(`Storage upload failed for ${path}: ${uploaded.error.message}`);
  };
  const newest = Date.now();
  for (const [index, photo] of photos.entries()) {
    checkpoint();
    const uploader = people[photo.uploader];
    // The path shapes photo_create_upload_attempt() hands out for a real upload.
    const paths = { original: `originals/${uploader}/${photo.id}/${photo.name}`, thumb: `derived/${uploader}/${photo.id}_thumb.webp`, preview: `derived/${uploader}/${photo.id}_preview.webp` };
    await put(paths.original, photo.bytes, photo.mime);
    await put(paths.thumb, sharp ? await scaled(photo.bytes, THUMB_PX) : photo.bytes, sharp ? 'image/webp' : photo.mime);
    await put(paths.preview, sharp ? await scaled(photo.bytes, PREVIEW_PX) : photo.bytes, sharp ? 'image/webp' : photo.mime);
    const inserted = await insertRow(sql, 'photos', photoColumns, {
      id: photo.id, job_id: photo.project === null ? null : projectIds[photo.project], uploader_id: uploader, kind: 'image', tags: photo.tags,
      captured_at: photo.capturedAt, captured_at_source: photo.capturedAtSource, original_path: paths.original, original_bytes: photo.bytes.length,
      mime_type: photo.mime, original_name: photo.name, thumb_path: paths.thumb, preview_path: paths.preview,
      content_sha256: createHash('sha256').update(photo.bytes).digest('hex'),
      // Uploads spread over the last few days, newest capture uploaded last, so "latest upload" ordering is not one instant.
      created_at: new Date(newest - (photos.length - index) * 3 * 3_600_000).toISOString(),
    });
    if (!inserted && !(await sql.query('select 1 from public.photos where id=$1', [photo.id])).rowCount) {
      photo.skipped = true;
      warnLoudly(`${photo.name} was not inserted: another photo already has exactly the same bytes.`);
    }
  }
  const seeded = photos.filter(photo => !photo.skipped);
  // ---- One photo in trash ----
  const trashed = seeded.find(photo => photo.project === 0 && !photo.tags.length) ?? seeded.find(photo => !photo.party);
  if (trashed && ['deleted_at', 'deleted_by', 'purge_after'].every(name => photoColumns.has(name))) {
    // photos_trash_consistent wants purge_after = deleted_at + 30 days exactly, so Postgres does the sum.
    await sql.query("update public.photos set deleted_at=$2, deleted_by=$3, purge_after=$2::timestamptz + interval '30 days' where id=$1 and deleted_at is null",
      [trashed.id, new Date(newest - 2 * 86_400_000).toISOString(), people.colleague]);
    trashed.trashed = true;
  }
  // ---- Albums (tables arrive with a later migration of plans/active/photo-albums/plan.md) ----
  const albumColumns = await columnsOf(sql, 'albums');
  const memberColumns = await columnsOf(sql, 'album_photos');
  if (albumColumns.size && memberColumns.size) {
    const active = seeded.filter(photo => !photo.trashed);
    const albums = [
      { name: 'Christmas Party 2015', by: 'reviewer', photos: active.filter(photo => photo.party) },
      { name: 'Marketing', by: 'colleague', photos: [0, 1, 2, 3].flatMap(projectIndex => active.filter(photo => photo.project === projectIndex).slice(0, 2)) },
      { name: 'Smith Residence – Finished', by: 'colleague', photos: active.filter(photo => photo.project === 1) }, // reads like an imported folder
      { name: 'Warranty Walkthroughs', by: 'reviewer', photos: [] },
    ];
    try {
      for (const album of albums) {
        const albumId = seedUuid(`album:${album.name}`);
        await insertRow(sql, 'albums', albumColumns, { id: albumId, name: album.name, created_by: people[album.by] });
        for (const photo of album.photos) await insertRow(sql, 'album_photos', memberColumns, { album_id: albumId, photo_id: photo.id, added_by: people[album.by] });
      }
    } catch (error) { warnLoudly(`Album seeding stopped: ${error.message}. The albums schema changed; update seed() in scripts/review-stack.mjs.`); }
    counts.albums = (await sql.query('select count(*)::int as n from public.albums')).rows[0].n;
    counts.albumPhotos = (await sql.query('select count(*)::int as n from public.album_photos')).rows[0].n;
  } else log('No albums tables at this migration stage: albums skipped');
  // ---- Counts come from the database, not from what the loop meant to do ----
  counts.people = (await sql.query('select count(*)::int as n from public.user_profiles where user_id=any($1::uuid[])', [Object.values(people)])).rows[0].n;
  counts.projects = (await sql.query('select count(*)::int as n from public.jobs')).rows[0].n;
  counts.projectsWithPhotos = (await sql.query('select count(distinct job_id)::int as n from public.photos where job_id is not null')).rows[0].n;
  counts.photos = (await sql.query('select count(*)::int as n from public.photos')).rows[0].n;
  counts.photosInTrash = photoColumns.has('deleted_at') ? (await sql.query('select count(*)::int as n from public.photos where deleted_at is not null')).rows[0].n : 0;
  counts.photosWithoutProject = (await sql.query('select count(*)::int as n from public.photos where job_id is null')).rows[0].n;
  counts.photosWithTags = (await sql.query("select count(*)::int as n from public.photos where tags<>'{}'")).rows[0].n;
  counts.usedPlaceholderImages = seeded.some(photo => photo.key.startsWith('placeholder-'));
  const sample = seeded.find(photo => photo.project === 0 && !photo.trashed);
  return { counts, sample: { projectId: projectIds[0], projectName: PROJECTS[0].name, photoId: sample?.id } };
}

async function seedPeople(sql, admin) {
  const profileColumns = await columnsOf(sql, 'user_profiles');
  const people = {};
  for (const person of PEOPLE) {
    let id = (await sql.query('select id from auth.users where phone=$1', [person.phone])).rows[0]?.id;
    if (!id) {
      const created = await admin.auth.admin.createUser({ phone: person.phone, phone_confirm: true, user_metadata: { full_name: person.fullName } });
      if (created.error || !created.data.user) throw new Error(`Cannot create the ${person.key}: ${created.error?.message}`);
      id = created.data.user.id;
    }
    // The on_auth_user_created trigger already made a nameless 'employee' profile; set the rest.
    await sql.query('insert into public.user_profiles(user_id, role, full_name) values($1,$2,$3) on conflict (user_id) do update set role=excluded.role, full_name=excluded.full_name', [id, person.role, person.fullName]);
    if (profileColumns.has('preferred_name')) await sql.query('update public.user_profiles set preferred_name=$2 where user_id=$1', [id, person.fullName.split(' ')[0]]);
    people[person.key] = id;
  }
  return people;
}

// ---- Next ---------------------------------------------------------------------------------------

// nextHttpServer() in test-http-services.mjs always runs `next dev` with the photos hostname
// blanked, so this is the minimum of it re-done: spawn detached, stop the whole process group.
function spawnNext(args, cwd, childEnv) {
  const child = spawn(process.execPath, [resolve(app, 'node_modules/next/dist/bin/next'), ...args], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  groupLeaders.add(child);
  return child;
}
async function stopNext(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  killChild(child, 'SIGTERM');
  const timer = setTimeout(() => killChild(child, 'SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function waitUntilServing(url, child) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    checkpoint();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Next exited before it served a page (see its output above)');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' })).status < 500) return; } catch {}
    await delay(500);
  }
  throw new Error(`Next did not serve ${url} within four minutes`);
}

// ---- Main ---------------------------------------------------------------------------------------

let started = false;
let sql;
let nextChild;
let wroteInfoFile = false;
const keepAlive = setInterval(() => {}, 1 << 30);
try {
  // Duplicated from test-integration.mjs: generate the config, boot, then prove the target is the
  // local stack this process just made BEFORE the first schema or data change.
  const bound = await migrationBound(options.migrationsThrough);
  const [apiPort, dbPort, shadowPort] = await Promise.all([freePort(), freePort(), freePort()]);
  await mkdir(resolve(workdir, 'supabase/migrations'), { recursive: true });
  const template = await readFile(resolve(app, 'integration/supabase.toml'), 'utf8');
  const otpHeader = '[auth.sms.test_otp]\n';
  if (!template.includes(otpHeader)) throw new Error('integration/supabase.toml no longer has an [auth.sms.test_otp] section to extend');
  await writeFile(resolve(workdir, 'supabase/config.toml'), template.replace(otpHeader, `${otpHeader}${REVIEWER_PHONE} = "${REVIEWER_CODE}"\n`)
    .replace('__PROJECT__', project).replace('__API_PORT__', String(apiPort)).replace('__DB_PORT__', String(dbPort)).replace('__SHADOW_PORT__', String(shadowPort)));
  log(`Starting disposable Supabase ${project} (first run may download Docker images)`);
  started = true;
  await cli('start', '--exclude', 'realtime,studio,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta');
  checkpoint();
  const status = JSON.parse(await cli('status', '--output', 'json'));
  env.DWS_TEST_DATABASE_URL = status.DB_URL;
  env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.ANON_KEY;
  env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
  assertLocalTestTarget(env); // loopback URLs, generated project name, local credentials, or it throws
  const containers = JSON.parse(await run('docker', ['inspect', `supabase_db_${project}`]));
  const container = containers[0];
  const ports = container.NetworkSettings.Ports['5432/tcp'] ?? [];
  if (container.Config.Labels['com.supabase.cli.project'] !== project || !ports.some(port => port.HostPort === new URL(env.DWS_TEST_DATABASE_URL).port)) throw new Error('Refusing mismatched Docker database identity');
  Object.assign(process.env, env); // the imported guards read process.env by default
  sql = new pg.Client({ connectionString: env.DWS_TEST_DATABASE_URL });
  sql.on('error', error => console.error(`[review-stack] database connection error: ${error.message}`)); // the failing query reports the rest
  await sql.connect();
  const version = (await sql.query('show server_version_num')).rows[0].server_version_num;
  if (Math.floor(Number(version) / 10000) !== 15) throw new Error('Isolated PostgreSQL must match production major version 15');
  log('Verified local PostgreSQL 15 and Docker identity before schema mutation');
  await sql.query('create schema dws_test_harness; revoke all on schema dws_test_harness from public, anon, authenticated; create table dws_test_harness.identity (project_id text primary key)');
  await sql.query('insert into dws_test_harness.identity values ($1)', [project]);

  // The runner's verifyExpansion() replays every file with no upper bound and asserts test-only
  // invariants; this tool needs --migrations-through, so it calls the exported replayer directly.
  if (bound.skipped.length) log(`--migrations-through ${options.migrationsThrough}: NOT applying ${bound.skipped.join(', ')}`);
  await replayMigrations(sql, bound.through ? { through: bound.through } : {});
  checkpoint();

  // Rows are inserted over the verified local connection and files go up with the service-role
  // key — the same two channels the browser specs seed through. Nothing goes through the UI.
  await assertDatabaseIdentity(sql, env);
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const people = await seedPeople(sql, admin);
  await reachEndState(sql, admin, people.admin);
  checkpoint();
  log(`Seeding from ${options.seedDir}`);
  const seeded = await seed(sql, admin, people, options.seedDir);
  await sql.end(); sql = undefined;
  log(`Seeded ${JSON.stringify(seeded.counts)}`);

  // Duplicated from test-integration.mjs. Next automatically loads .env.local, so it runs from a
  // source-only snapshot: no .env files, no stale .next, and immune to edits made while it is up.
  const snapshot = resolve(workdir, 'app');
  await mkdir(snapshot);
  for (const name of ['src', 'public', 'baml_client', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'next-env.d.ts']) {
    try { await cp(resolve(app, name), resolve(snapshot, name), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await symlink(resolve(app, 'node_modules'), resolve(snapshot, 'node_modules'), 'dir');
  // Next gets only what it needs: no database URL, no Docker settings, nothing inherited.
  const buildEnv = {
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'].filter(key => env[key]).map(key => [key, env[key]])),
    NODE_ENV: options.dev ? 'development' : 'production', NEXT_TELEMETRY_DISABLED: '1', NEXT_ESLINT_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_PHOTOS_HOSTNAME: 'localhost', // so "/" behaves as the photos address
    MCP_SHARED_KEY: randomBytes(32).toString('hex'), CRON_SECRET: randomBytes(32).toString('hex'),
  };
  if (!options.dev) {
    log('Building the app (next build); this takes a minute or two');
    const build = spawnNext(['build'], snapshot, buildEnv);
    activeChild = build;
    const [code] = await once(build, 'exit');
    if (activeChild === build) activeChild = undefined;
    checkpoint();
    if (code !== 0) throw new Error(`next build failed (${code}); see its output above`);
  }
  // Chosen after the build so the port is not left unclaimed for minutes. Only server code reads
  // DWS_BROWSER_ORIGIN at run time, so the build does not need it.
  const port = await freePort();
  const url = `http://localhost:${port}`;
  nextChild = spawnNext([options.dev ? 'dev' : 'start', '--hostname', 'localhost', '--port', String(port)], snapshot, { ...buildEnv, DWS_BROWSER_ORIGIN: url });
  nextChild.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[review-stack] Next exited unexpectedly (${code ?? signal})`);
    process.exitCode = 1; shuttingDown = true; wake();
  });
  await waitUntilServing(`${url}/login`, nextChild);

  const info = {
    url, loginUrl: `${url}/login`, phone: `+${REVIEWER_PHONE}`, code: REVIEWER_CODE, reviewerName: PEOPLE[0].fullName,
    seeded: seeded.counts, sample: seeded.sample, warnings, projectId: project, workdir,
    mode: options.dev ? 'next dev' : 'next start', migrationsThrough: options.migrationsThrough ?? 'all', supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL, pid: process.pid,
  };
  if (options.infoFile) {
    await mkdir(resolve(options.infoFile, '..'), { recursive: true });
    await writeFile(options.infoFile, `${JSON.stringify(info, null, 2)}\n`);
    wroteInfoFile = true;
  }
  console.log(`\nREVIEW STACK READY — sign in at ${info.loginUrl} with ${REVIEWER_PHONE_DISPLAY} and code ${REVIEWER_CODE}. Ctrl-C (or kill ${process.pid}) stops and removes everything.`);
  console.log(JSON.stringify(info, null, 2));
  await stopRequested;
} catch (error) {
  // After a stop signal the step that was cut short fails; that is the stop working, not an error.
  if (!(error instanceof Interrupted) && !signalled) { console.error(error); process.exitCode = 1; }
} finally {
  shuttingDown = true; // from here on a signal must not interrupt the cleanup commands
  clearInterval(keepAlive);
  for (const result of await Promise.allSettled([stopNext(nextChild), activeChild && stopNext(activeChild), sql?.end()])) {
    if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
  }
  // Duplicated from test-integration.mjs.
  let removed = !started;
  if (started) {
    try {
      // Docker serializes pruning; simultaneous isolated stacks can contend here.
      for (let attempt = 0; ; attempt++) {
        try { await cli('stop', '--no-backup'); break; }
        catch (error) { if (attempt === 2) throw error; await delay(1000); }
      }
      removed = true;
      log(`Removed disposable Supabase ${project}`);
    } catch (error) { console.error(error); console.error(`Local cleanup configuration retained at ${workdir}`); process.exitCode = 1; }
  }
  if (removed) await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (wroteInfoFile) await rm(options.infoFile, { force: true });
  if (removed) log('Removed the workdir. Done.');
}
process.exit(process.exitCode ?? 0);
