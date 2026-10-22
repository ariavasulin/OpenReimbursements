// The bridge: a tiny HTTP service on 127.0.0.1 that runs one named, read-only
// statement from queries.json on the shop's SQL Server and returns rows as JSON.
// It never runs SQL sent by a caller. cloudflared on the same box is its only
// client. Run directly, it also starts the mirror loop.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueries } from './config.mjs';
import { buildConfig, closePool, getPool as defaultGetPool } from './db.mjs';
import { createMirror, createMirrorApi, DEFAULT_MIRROR_INTERVAL_MINUTES, DEFAULT_MIRROR_MAX_ROWS } from './mirror.mjs';
import { QUERY_TIMEOUT_MS, runQuery, timeoutMessage } from './query.mjs';
import { isIdentifier, isPlainObject, plainRow } from './types.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_ROWS = 5000;
const MAX_ROWS_CAP = 50000;
const MIN_TOKEN_CHARS = 32;
const tokenUsable = (token) => Boolean(token) && token.length >= MIN_TOKEN_CHARS;
const QUERY_PREFIX = '/query/';
// Exit code for a configuration problem found at startup. install/setup.ps1 tells
// NSSM not to restart on it, so a bad setting stops the service instead of looping.
const EXIT_CONFIG = 78;
const BODY_KEYS = ['params', 'maxRows'];

// Errors that mean "could not talk to SQL Server at all".
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ELOGIN', 'ESOCKET', 'EINSTLOOKUP', 'ECONNCLOSED', 'ENOTOPEN', 'ENOCONN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EALREADYCONNECTING',
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Map any thrown error to an HttpError: HttpErrors pass through, driver errors get a status, the rest are 500. */
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err?.code === 'ECONFIG') {
    return new HttpError(503, 'not_configured', `The bridge is not configured: ${err.message}.`);
  }
  // A ConnectionError with ETIMEOUT is a connect timeout: unreachable, not a slow query.
  if (err?.name === 'ConnectionError' || CONNECTION_CODES.has(err?.code)) {
    return new HttpError(502, 'db_unreachable', `Could not reach the shop database (${err.code ?? 'unknown error'}).`);
  }
  if (err?.code === 'ETIMEOUT') {
    return new HttpError(504, 'timeout', timeoutMessage(QUERY_TIMEOUT_MS));
  }
  if (err?.code === 'EREQUEST' || err?.name === 'RequestError') {
    return new HttpError(400, 'bad_request', `SQL Server rejected the query: ${err.message}`);
  }
  return new HttpError(500, 'internal_error', 'Unexpected error in the bridge.');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const errorBody = (err) => ({ error: { code: err.code, message: err.message } });

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest();

/** Read the request body, or throw 413. Drains (up to 1 MiB) so the client sees the 413. */
async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  const chunks = [];
  let total = 0;
  let tooLarge = declared > MAX_BODY_BYTES;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) tooLarge = true;
    if (tooLarge) {
      if (total > 1024 * 1024) break;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, 'payload_too_large', `The request body is over ${MAX_BODY_BYTES / 1024} KiB.`);
  return Buffer.concat(chunks).toString('utf8');
}

/** Body of POST /query/<name>: `{ params?, maxRows? }`; an empty body means `{}`. */
function parseQueryBody(text) {
  let body = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_request', 'The request body is not valid JSON.');
    }
  }
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'bad_request', 'The request body must be a JSON object.');
  }
  const unknown = Object.keys(body).find((key) => !BODY_KEYS.includes(key));
  if (unknown) {
    throw new HttpError(400, 'bad_request', `Unknown field "${unknown}"; the body takes only "params" and "maxRows".`);
  }
  const params = body.params ?? {};
  if (!isPlainObject(params)) {
    throw new HttpError(400, 'bad_request', '"params" must be an object of name to value.');
  }
  for (const [name, value] of Object.entries(params)) {
    if (!isIdentifier(name)) {
      throw new HttpError(400, 'bad_request', `Parameter name "${name}" is not a plain identifier.`);
    }
    const t = typeof value;
    if (!(value === null || t === 'string' || t === 'boolean' || (t === 'number' && Number.isFinite(value)))) {
      throw new HttpError(400, 'bad_request', `Parameter "${name}" must be a string, number, boolean, or null.`);
    }
  }
  let maxRows = DEFAULT_MAX_ROWS;
  if (body.maxRows !== undefined) {
    if (!Number.isInteger(body.maxRows) || body.maxRows < 1) {
      throw new HttpError(400, 'bad_request', '"maxRows" must be a positive whole number.');
    }
    maxRows = Math.min(body.maxRows, MAX_ROWS_CAP);
  }
  return { params, maxRows };
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} [deps.getPool]  mssql pool (stubbed in tests)
 * @param {string} [deps.token]  SHOP_BRIDGE_TOKEN
 * @param {string} [deps.server]  shown in /health
 * @param {string} [deps.database]  shown in /health
 * @param {() => object} [deps.mirrorStatus]
 * @param {Record<string, string>} [deps.live]  the `live` statements from queries.json, by name
 * @param {string[]} [deps.mirrorNames]  the `into` names of the `mirror` entries, shown in /health
 * @param {(line: string) => void} [deps.log]
 */
export function createHandler({
  getPool = defaultGetPool,
  token,
  server = null,
  database = null,
  mirrorStatus = () => ({ enabled: false }),
  live = {},
  mirrorNames = [],
  log = (line) => console.log(line),
} = {}) {
  const queries = { mirror: [...mirrorNames], live: Object.keys(live) };
  const expectedDigest = tokenUsable(token) ? sha256(token) : null;

  function requireAuth(req) {
    if (!expectedDigest) {
      throw new HttpError(503, 'not_configured', `SHOP_BRIDGE_TOKEN is not set (or is shorter than ${MIN_TOKEN_CHARS} characters).`);
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    // Hashing both sides gives equal-length buffers, so the compare leaks neither content nor length.
    if (!match || !timingSafeEqual(sha256(match[1].trim()), expectedDigest)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong bearer token.');
    }
  }

  // The log file is where the shop's admin finds out why a request failed, so a
  // server-side failure logs the underlying error's code and message (never the
  // request's params, headers, or URL).
  function logFailure(raw, status) {
    if (raw instanceof HttpError || status < 500) return;
    log(`${new Date().toISOString()} error ${status}: code=${raw?.code ?? '-'} message=${JSON.stringify(String(raw?.message ?? raw))}`);
    if (status === 500 && raw?.stack) log(raw.stack);
  }

  async function health() {
    const started = Date.now();
    const report = (fields) => ({ ...fields, server, database, mirror: mirrorStatus(), queries, durationMs: Date.now() - started });
    try {
      const pool = await getPool();
      const { rows } = await runQuery(pool, 'SELECT @@VERSION AS version', {}, { maxRows: 1 });
      const version = String(rows[0]?.version ?? '').split('\n')[0].trim();
      return [200, report({ ok: true, version })];
    } catch (raw) {
      const err = toHttpError(raw);
      logFailure(raw, err.status);
      return [err.status, report({ ok: false, version: null, ...errorBody(err) })];
    }
  }

  async function query(req, name, info) {
    requireAuth(req);
    // config.mjs already checked every name and statement when queries.json loaded.
    if (!Object.hasOwn(live, name)) {
      throw new HttpError(404, 'not_found', `No live query named "${name}".`);
    }
    const sql = live[name];
    info.name = name;
    info.sql = sql;
    const { params, maxRows } = parseQueryBody(await readBody(req));
    const started = Date.now();
    const pool = await getPool();
    const { columns, rows, truncated } = await runQuery(pool, sql, params, { maxRows });
    info.rowCount = rows.length;
    info.truncated = truncated;
    return [200, { columns, rows: rows.map(plainRow), rowCount: rows.length, truncated, durationMs: Date.now() - started }];
  }

  return async function handler(req, res) {
    const started = Date.now();
    const info = { name: null, sql: null, rowCount: null, truncated: null };
    let pathname = '(invalid URL)';
    let status = 500;
    try {
      let url;
      try {
        url = new URL(req.url, 'http://bridge.local');
      } catch {
        throw new HttpError(400, 'bad_request', 'Invalid request URL.');
      }
      pathname = url.pathname;
      let result;
      if (req.method === 'GET' && pathname === '/health') result = await health();
      else if (req.method === 'POST' && pathname.startsWith(QUERY_PREFIX)) {
        result = await query(req, pathname.slice(QUERY_PREFIX.length), info);
      } else throw new HttpError(404, 'not_found', `No route for ${req.method} ${pathname}.`);
      status = result[0];
      sendJson(res, status, result[1]);
    } catch (raw) {
      const err = toHttpError(raw);
      status = err.status;
      logFailure(raw, status);
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, errorBody(err));
    } finally {
      const sqlSnippet = info.sql == null ? '-' : JSON.stringify(info.sql.replace(/\s+/g, ' ').trim().slice(0, 80));
      log([
        new Date().toISOString(), req.method, pathname, status, `${Date.now() - started}ms`,
        `rows=${info.rowCount ?? '-'}`, `truncated=${info.truncated ?? '-'}`,
        ...(info.name ? [`name=${info.name}`] : []), `sql=${sqlSnippet}`,
      ].join(' '));
    }
  };
}

/** A whole number in [min, max] from an env value (fallback when unset), else null. */
export function wholeNumber(raw, fallback, min, max) {
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Why the mirror settings cannot be used, or null. Called when SHOP_MIRROR_SUPABASE_URL is set. */
export function mirrorSettingsProblem(env) {
  let url;
  try {
    url = new URL(env.SHOP_MIRROR_SUPABASE_URL.trim());
  } catch {
    return 'SHOP_MIRROR_SUPABASE_URL is not a URL (expected https://<project-ref>.supabase.co)';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return 'SHOP_MIRROR_SUPABASE_URL must start with https://';
  }
  if (!(env.SHOP_MIRROR_API_KEY ?? '').trim()) {
    return 'SHOP_MIRROR_API_KEY is not set (the Supabase project\'s anon or publishable key)';
  }
  if (!tokenUsable(env.SHOP_MIRROR_TOKEN)) {
    return `SHOP_MIRROR_TOKEN is missing or shorter than ${MIN_TOKEN_CHARS} characters`;
  }
  return null;
}

function main() {
  const env = process.env;
  const say = (line) => console.log(`${new Date().toISOString()} ${line}`);

  const port = wholeNumber(env.SHOP_BRIDGE_PORT, 8787, 1, 65535);
  const intervalMinutes = wholeNumber(env.SHOP_MIRROR_INTERVAL_MINUTES, DEFAULT_MIRROR_INTERVAL_MINUTES, 1, 10080);
  const maxRows = wholeNumber(env.SHOP_MIRROR_MAX_ROWS, DEFAULT_MIRROR_MAX_ROWS, 1, Number.MAX_SAFE_INTEGER);
  for (const [name, value, rule] of [
    ['SHOP_BRIDGE_PORT', port, 'a port number'],
    ['SHOP_MIRROR_INTERVAL_MINUTES', intervalMinutes, 'a whole number of minutes from 1 to 10080'],
    ['SHOP_MIRROR_MAX_ROWS', maxRows, 'a positive whole number'],
  ]) {
    if (value === null) {
      say(`${name} must be ${rule} (got ${JSON.stringify(env[name])}); not starting`);
      process.exitCode = EXIT_CONFIG;
      return;
    }
  }

  // queries.json is the only SQL this program runs. Any problem in it stops the service here.
  const queriesPath = env.SHOP_QUERIES_FILE
    ? path.resolve(env.SHOP_QUERIES_FILE)
    : fileURLToPath(new URL('./queries.json', import.meta.url));
  const loaded = loadQueries(queriesPath);
  if (!loaded.ok) {
    say(`${queriesPath} is not valid; not starting:`);
    for (const error of loaded.errors) say(`  ${error}`);
    process.exitCode = EXIT_CONFIG;
    return;
  }
  const { queries } = loaded;
  say(`loaded ${queriesPath}: ${queries.mirror.length} mirror, ${Object.keys(queries.live).length} live`);

  // The SQL Server settings are first used on the first query; check them now, so a
  // wrong one stops the service instead of failing every run.
  try {
    buildConfig(env);
  } catch (err) {
    say(`${err.message}; not starting`);
    process.exitCode = EXIT_CONFIG;
    return;
  }

  let mirror = null;
  const supabaseUrl = (env.SHOP_MIRROR_SUPABASE_URL ?? '').trim();
  if (supabaseUrl) {
    const problem = mirrorSettingsProblem(env);
    if (problem) {
      say(`${problem}; not starting`);
      process.exitCode = EXIT_CONFIG;
      return;
    }
    mirror = createMirror({
      getPool: defaultGetPool,
      api: createMirrorApi({ supabaseUrl, apiKey: env.SHOP_MIRROR_API_KEY.trim(), token: env.SHOP_MIRROR_TOKEN }),
      mirror: queries.mirror,
      maxRows,
      intervalMinutes,
    });
  } else {
    say('SHOP_MIRROR_SUPABASE_URL is not set: the mirror is off');
  }
  if (!tokenUsable(env.SHOP_BRIDGE_TOKEN)) {
    say(`SHOP_BRIDGE_TOKEN is missing or shorter than ${MIN_TOKEN_CHARS} characters: /query/<name> answers 503`);
  }

  const handler = createHandler({
    token: env.SHOP_BRIDGE_TOKEN,
    server: env.SHOP_DB_SERVER ?? null,
    database: env.SHOP_DB_NAME ?? null,
    mirrorStatus: mirror ? () => mirror.status() : undefined,
    live: queries.live,
    mirrorNames: queries.mirror.map((entry) => entry.into),
  });
  const httpServer = http.createServer(handler);
  httpServer.listen(port, '127.0.0.1', () => {
    say(`bridge listening on http://127.0.0.1:${port}`);
    mirror?.start();
  });

  const shutdown = (signal) => {
    say(`${signal}: shutting down`);
    mirror?.stop();
    httpServer.close();
    closePool().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start only when run directly (`node server.mjs`), not when imported by tests.
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
if (process.argv[1] && norm(path.resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url))) {
  main();
}
