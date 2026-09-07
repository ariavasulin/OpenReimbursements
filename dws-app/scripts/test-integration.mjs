import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { verifyExpansion } from './test-schema-expansion.mjs';
import { assertLocalTestTarget } from './test-local-target.mjs';

const suite = process.argv[2];
if (!['db', 'routes', 'browser'].includes(suite)) throw new Error('Usage: node scripts/test-integration.mjs db|routes|browser [runner arguments]');
const app = resolve(import.meta.dirname, '..');
const project = `dws-test-${randomBytes(6).toString('hex')}`;
const workdir = await mkdtemp(resolve(tmpdir(), `${project}-`));
// Allowlist system plumbing only: neither parent app secrets nor .env.local is loaded.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'LANG', 'TERM'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.CI = '1';
env.NODE_ENV = 'test';
env.DWS_TEST_PROJECT = project;
let activeChild;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  // Playwright handles SIGINT by closing browsers and its Next process group.
  activeChild?.kill(activeChild.spawnargs.some(arg => arg.includes('@playwright/test')) ? 'SIGINT' : 'SIGTERM');
});
const cli = (...args) => run('supabase', [...args, '--workdir', workdir], { capture: true });
function run(command, args, { capture = false, childEnv = env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: app, env: childEnv, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    activeChild = child;
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
async function freePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort); });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
let started = false;
let sql;
try {
  const [apiPort, dbPort, shadowPort] = await Promise.all([freePort(), freePort(), freePort()]);
  await mkdir(resolve(workdir, 'supabase/migrations'), { recursive: true });
  const template = await readFile(resolve(app, 'integration/supabase.toml'), 'utf8');
  await writeFile(resolve(workdir, 'supabase/config.toml'), template.replace('__PROJECT__', project).replace('__API_PORT__', String(apiPort)).replace('__DB_PORT__', String(dbPort)).replace('__SHADOW_PORT__', String(shadowPort)));
  console.log(`Starting disposable Supabase ${project} (first run may download Docker images)`);
  started = true;
  await cli('start', '--exclude', 'realtime,studio,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta');
  if (interrupted) throw new Error('Integration run interrupted');
  const status = JSON.parse(await cli('status', '--output', 'json'));
  env.DWS_TEST_DATABASE_URL = status.DB_URL;
  env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.ANON_KEY;
  env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
  assertLocalTestTarget(env);
  // Verify Docker identity and mapped port before the first schema/fixture mutation.
  const containers = JSON.parse(await run('docker', ['inspect', `supabase_db_${project}`], { capture: true }));
  const container = containers[0];
  const ports = container.NetworkSettings.Ports['5432/tcp'] ?? [];
  if (container.Config.Labels['com.supabase.cli.project'] !== project || !ports.some(port => port.HostPort === new URL(env.DWS_TEST_DATABASE_URL).port)) throw new Error('Refusing mismatched Docker database identity');
  Object.assign(process.env, env);
  sql = new pg.Client({ connectionString: env.DWS_TEST_DATABASE_URL });
  await sql.connect();
  const version = (await sql.query('show server_version_num')).rows[0].server_version_num;
  if (Math.floor(Number(version) / 10000) !== 15) throw new Error('Isolated PostgreSQL must match production major version 15');
  console.log('Verified local PostgreSQL 15 and Docker identity before schema mutation');
  await sql.query('create schema dws_test_harness; revoke all on schema dws_test_harness from public, anon, authenticated; create table dws_test_harness.identity (project_id text primary key)');
  await sql.query('insert into dws_test_harness.identity values ($1)', [project]);
  await verifyExpansion(sql, env);
  await sql.end(); sql = undefined;
  if (suite === 'browser') {
    // Next automatically loads .env.local. Run an explicit source-only snapshot
    // so neither live secrets nor a stale compiled public URL can enter this app.
    const browserApp = resolve(workdir, 'app');
    await mkdir(browserApp);
    for (const name of ['src', 'public', 'baml_client', 'package.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'next-env.d.ts']) {
      try { await cp(resolve(app, name), resolve(browserApp, name), { recursive: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await symlink(resolve(app, 'node_modules'), resolve(browserApp, 'node_modules'), 'dir');
    const port = await freePort();
    await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(3)], {
      childEnv: { ...env, NODE_ENV: 'development', NEXT_PUBLIC_PHOTOS_HOSTNAME: '',
        NEXT_TELEMETRY_DISABLED: '1', DWS_BROWSER_APP_DIR: browserApp,
        DWS_BROWSER_BASE_URL: `http://localhost:${port}`, DWS_BROWSER_PORT: String(port) },
    });
  } else {
    await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts', ...process.argv.slice(3)], { childEnv: { ...env, DWS_TEST_SUITE: suite } });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql?.end();
  let removed = !started;
  if (started) {
    try {
      // Docker serializes pruning; simultaneous isolated suites can contend here.
      for (let attempt = 0; ; attempt++) {
        try { await cli('stop', '--no-backup'); break; }
        catch (error) { if (attempt === 2) throw error; await delay(1000); }
      }
      removed = true;
      console.log(`Removed disposable Supabase ${project}`);
    }
    catch (error) { console.error(error); console.error(`Local cleanup configuration retained at ${workdir}`); process.exitCode = 1; }
  }
  if (removed) await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
