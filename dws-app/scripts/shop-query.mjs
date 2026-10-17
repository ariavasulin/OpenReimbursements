#!/usr/bin/env node
// Query the shop database from your laptop through the shop bridge (Cloudflare Tunnel).
// Read-only: the bridge accepts a single SELECT and the SQL login cannot write.
//
// Env (same four as Vercel; put them in .env.local):
//   SHOP_BRIDGE_URL, SHOP_BRIDGE_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//
// Usage (from dws-app/):
//   node --env-file=.env.local scripts/shop-query.mjs "select top 5 ProjectID, Project from tblProject order by ProjectID desc"
//   node --env-file=.env.local scripts/shop-query.mjs --json "select count(*) as n from tblContact"
//   node --env-file=.env.local scripts/shop-query.mjs --param id=3612 "select * from tblProject where ProjectID = @id"
//   node --env-file=.env.local scripts/shop-query.mjs --max-rows 20000 "select * from tblProject"
//   node --env-file=.env.local scripts/shop-query.mjs --health
//   node --env-file=.env.local scripts/shop-query.mjs --ddl tblPM tblProjContact   # migration SQL for new mirror tables

function parseArgs(argv) {
  const args = { sql: null, json: false, health: false, ddl: [], maxRows: undefined, params: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--health') args.health = true;
    else if (a === '--ddl') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.ddl.push(argv[++i]); }
    else if (a === '--max-rows') args.maxRows = Number(argv[++i]);
    else if (a === '--param') {
      const [name, ...rest] = String(argv[++i]).split('=');
      const raw = rest.join('=');
      args.params[name] = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (args.sql === null) args.sql = a;
    else { console.error(`Unexpected argument: ${a}`); usage(); process.exit(2); }
  }
  return args;
}

function usage() {
  console.error('Usage: node --env-file=.env.local scripts/shop-query.mjs [--json] [--max-rows N] [--param name=value]... "<select ...>" | --health | --ddl tblA [tblB...]');
}

function config() {
  const url = process.env.SHOP_BRIDGE_URL;
  const token = process.env.SHOP_BRIDGE_TOKEN;
  if (!url || !token) {
    console.error('Missing SHOP_BRIDGE_URL or SHOP_BRIDGE_TOKEN in the environment (use node --env-file=.env.local).');
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  } else {
    console.error('Note: CF_ACCESS_CLIENT_ID/SECRET not set; this only works on the shop LAN, not through the tunnel.');
  }
  return { url: url.replace(/\/+$/, ''), headers };
}

async function request(path, init) {
  const { url, headers } = config();
  let res;
  try {
    res = await fetch(`${url}${path}`, { ...init, headers, signal: AbortSignal.timeout(40_000), redirect: 'manual' });
  } catch (error) {
    console.error(`Could not reach the bridge: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message || error}`);
    process.exit(1);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    if (res.status === 403 || (res.status >= 300 && res.status < 400)) {
      console.error(`Blocked at the Cloudflare edge (HTTP ${res.status}). Check CF_ACCESS_CLIENT_ID/SECRET and the Access policy.`);
    } else {
      const err = body?.error;
      console.error(`Bridge error HTTP ${res.status}: ${typeof err === 'object' && err ? `${err.code ?? ''} ${err.message ?? ''}`.trim() : err || text.slice(0, 200)}`);
    }
    process.exit(1);
  }
  return body;
}

function printTable(columns, rows) {
  if (rows.length === 0) { console.log('(0 rows)'); return; }
  const cell = v => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));
  const widths = columns.map(c => Math.min(40, Math.max(c.length, ...rows.map(r => cell(r[c]).length))));
  const line = (vals) => vals.map((v, i) => cell(v).slice(0, widths[i]).padEnd(widths[i])).join('  ');
  console.log(line(columns));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(columns.map(c => r[c])));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.health) {
    const health = await request('/health', { method: 'GET' });
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  if (args.ddl.length) {
    const body = await request(`/ddl?tables=${encodeURIComponent(args.ddl.join(','))}`, { method: 'GET' });
    process.stdout.write(typeof body === 'string' ? body : body.sql ?? JSON.stringify(body, null, 2));
    if (!String(body?.sql ?? body).endsWith('\n')) process.stdout.write('\n');
    return;
  }
  if (!args.sql) { usage(); process.exit(2); }
  const payload = { sql: args.sql, params: args.params };
  if (args.maxRows !== undefined) payload.maxRows = args.maxRows;
  const result = await request('/query', { method: 'POST', body: JSON.stringify(payload) });
  if (args.json) {
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    printTable(result.columns, result.rows);
    console.error(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ' (truncated; raise --max-rows)' : ''} in ${result.durationMs} ms`);
  }
}

main().catch(error => { console.error(error?.message || error); process.exit(1); });
