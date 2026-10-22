#!/usr/bin/env node
// Run one of the shop bridge's named queries from your laptop (through the Cloudflare
// Tunnel). The bridge accepts no SQL: it runs only the queries named in its own config,
// listed by --health under queries.live.
//
// Env (same four as Vercel; put them in .env.local):
//   SHOP_BRIDGE_URL, SHOP_BRIDGE_TOKEN, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//
// Usage (from dws-app/):
//   node --env-file=.env.local scripts/shop-query.mjs --health
//   node --env-file=.env.local scripts/shop-query.mjs <name> [--param k=v ...] [--max-rows N] [--json]
// --param values that look like numbers, true, false, or null are sent as those types.

const QUERY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LITERALS = { null: null, true: true, false: false };

function parseArgs(argv) {
  const args = { name: null, json: false, health: false, maxRows: undefined, params: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--health') args.health = true;
    else if (a === '--max-rows') args.maxRows = Number(argv[++i]);
    else if (a === '--param') {
      const [key, ...rest] = String(argv[++i]).split('=');
      const raw = rest.join('=');
      args.params ??= {};
      args.params[key] = Object.hasOwn(LITERALS, raw) ? LITERALS[raw] : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); usage(); process.exit(2); }
    else if (args.name === null) args.name = a;
    else { console.error(`Unexpected argument: ${a}`); usage(); process.exit(2); }
  }
  return args;
}

function usage() {
  console.error('Usage: node --env-file=.env.local scripts/shop-query.mjs --health');
  console.error('       node --env-file=.env.local scripts/shop-query.mjs <name> [--param k=v ...] [--max-rows N] [--json]');
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
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if (res.status === 403 || (res.status >= 300 && res.status < 400)) {
      console.error(`Blocked at the Cloudflare edge (HTTP ${res.status}). Check CF_ACCESS_CLIENT_ID/SECRET and the Access policy.`);
    } else {
      const err = body?.error;
      console.error(`Bridge error HTTP ${res.status}: ${err ? `${err.code ?? ''} ${err.message ?? ''}`.trim() : text.slice(0, 200)}`);
    }
    process.exit(1);
  }
  return body;
}

function printTable(columns, rows) {
  if (rows.length === 0) { console.log('(0 rows)'); return; }
  const cell = v => (v === null || v === undefined ? '' : String(v));
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
  if (!args.name) { usage(); process.exit(2); }
  if (!QUERY_NAME.test(args.name)) {
    console.error(`Not a query name: ${args.name} (the bridge takes a named query, not SQL; see --health for the list)`);
    process.exit(2);
  }
  const payload = {};
  if (args.params !== undefined) payload.params = args.params;
  if (args.maxRows !== undefined) payload.maxRows = args.maxRows;
  const result = await request(`/query/${args.name}`, { method: 'POST', body: JSON.stringify(payload) });
  if (args.json) {
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    printTable(result.columns, result.rows);
    console.error(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ' (truncated; raise --max-rows)' : ''} in ${result.durationMs} ms`);
  }
}

main().catch(error => { console.error(error?.message || error); process.exit(1); });
