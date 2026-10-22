// The bridge: a tiny HTTP service on 127.0.0.1 that runs one named, read-only
// statement from queries.json on the shop's SQL Server and returns rows as JSON.
// It never runs SQL sent by a caller. cloudflared on the same box is its only
// client. Run directly, it also starts the mirror loop.
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueries } from './config.mjs';
import { closePool, getPool as defaultGetPool } from './db.mjs';
import { checkReadOnlySql } from './guard.mjs';
import { createMirror, DEFAULT_MIRROR_MAX_ROWS } from './mirror.mjs';
import { isIdentifier, orderedColumns } from './types.mjs';

export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_ROWS = 5000;
export const MAX_ROWS_CAP = 50000;
const QUERY_PREFIX = '/query/';
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

/** Map a driver error to an HTTP status and error body. */
export function classifyDbError(err) {
  if (err instanceof HttpError) return err;
  if (err?.code === 'ECONFIG') {
    return new HttpError(503, 'not_configured', `The bridge is not configured: ${err.message}.`);
  }
  // A ConnectionError with ETIMEOUT is a connect timeout: unreachable, not a slow query.
  if (err?.name === 'ConnectionError' || CONNECTION_CODES.has(err?.code)) {
    return new HttpError(502, 'db_unreachable', `Could not reach the shop database (${err.code ?? 'unknown error'}).`);
  }
  if (err?.code === 'ETIMEOUT') {
    return new HttpError(504, 'timeout', 'The query ran longer than 30 seconds and was cancelled.');
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
  if (tooLarge) throw new HttpError(413, 'payload_too_large', 'The request body is over 64 KiB.');
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'The request body must be a JSON object.');
  }
  const unknown = Object.keys(body).find((key) => !BODY_KEYS.includes(key));
  if (unknown) {
    throw new HttpError(400, 'bad_request', `Unknown field "${unknown}"; the body takes only "params" and "maxRows".`);
  }
  const params = body.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) {
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

function toJsonSafeRow(row) {
  for (const key of Object.keys(row)) {
    if (Buffer.isBuffer(row[key])) row[key] = row[key].toString('hex');
  }
  return row;
}

/**
 * Stream the query and stop after maxRows + 1 rows, so a huge result never sits
 * in memory: the extra row proves truncation, then the request is cancelled.
 * mssql emits 'done' after every outcome (including 'error' and cancel).
 */
export function runQuery(pool, sql, params, maxRows) {
  return new Promise((resolve, reject) => {
    const request = pool.request();
    request.stream = true;
    for (const [name, value] of Object.entries(params)) request.input(name, value);

    let columns = null;
    let recordsets = 0;
    const rows = [];
    let truncated = false;
    let error = null;

    request.on('recordset', (meta) => {
      recordsets += 1;
      if (recordsets === 1) {
        columns = orderedColumns(meta).map((c) => c.name);
      }
    });
    request.on('row', (row) => {
      if (truncated || recordsets > 1) return; // only the first result set is returned
      if (rows.length < maxRows) {
        rows.push(toJsonSafeRow(row));
      } else {
        truncated = true;
        request.cancel();
      }
    });
    request.on('error', (err) => {
      if (truncated && err?.code === 'ECANCEL') return; // our own cancel
      error ??= err;
    });
    request.on('done', () => {
      if (error) reject(error);
      else resolve({ columns: columns ?? [], rows, truncated });
    });
    const pending = request.query(sql);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  });
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
  const expectedDigest = token && token.length >= 32 ? sha256(token) : null;

  function requireAuth(req) {
    if (!expectedDigest) {
      throw new HttpError(503, 'not_configured', 'SHOP_BRIDGE_TOKEN is not set (or is shorter than 32 characters).');
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    // Hashing both sides gives equal-length buffers, so the compare leaks neither content nor length.
    if (!match || !timingSafeEqual(sha256(match[1].trim()), expectedDigest)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong bearer token.');
    }
  }

  async function health() {
    const started = Date.now();
    const base = { server, database };
    try {
      const pool = await getPool();
      const result = await pool.request().query('SELECT @@VERSION AS version');
      const version = String(result.recordset?.[0]?.version ?? '').split('\n')[0].trim();
      return [200, { ok: true, ...base, version, mirror: mirrorStatus(), queries, durationMs: Date.now() - started }];
    } catch (raw) {
      const err = classifyDbError(raw);
      return [err.status, {
        ok: false,
        ...base,
        version: null,
        mirror: mirrorStatus(),
        queries,
        durationMs: Date.now() - started,
        error: { code: err.code, message: err.message },
      }];
    }
  }

  async function query(req, name, info) {
    requireAuth(req);
    // Checked only after auth, so the names cannot be probed without the token.
    if (!isIdentifier(name) || !Object.hasOwn(live, name) || typeof live[name] !== 'string') {
      throw new HttpError(404, 'not_found', `No live query named "${name}".`);
    }
    const sql = live[name];
    info.name = name;
    info.sql = sql;
    const { params, maxRows } = parseQueryBody(await readBody(req));
    // Already checked when queries.json loaded; failing here means the statement changed under us.
    const verdict = checkReadOnlySql(sql);
    if (!verdict.ok) throw new Error(`live query "${name}" failed the read-only guard at run time: ${verdict.reason}`);
    const started = Date.now();
    const pool = await getPool();
    const { columns, rows, truncated } = await runQuery(pool, sql, params, maxRows);
    info.rowCount = rows.length;
    info.truncated = truncated;
    return [200, { columns, rows, rowCount: rows.length, truncated, durationMs: Date.now() - started }];
  }

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://bridge.local');
    const info = { name: null, sql: null, rowCount: null, truncated: null };
    let status = 500;
    try {
      let result;
      if (req.method === 'GET' && url.pathname === '/health') result = await health();
      else if (req.method === 'POST' && url.pathname.startsWith(QUERY_PREFIX)) {
        result = await query(req, url.pathname.slice(QUERY_PREFIX.length), info);
      } else throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}.`);
      status = result[0];
      sendJson(res, status, result[1]);
    } catch (raw) {
      const err = classifyDbError(raw);
      status = err.status;
      if (status === 500) log(`${new Date().toISOString()} unexpected error: ${raw?.stack ?? raw}`);
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, errorBody(err));
    } finally {
      const sqlSnippet = info.sql == null ? '-' : JSON.stringify(info.sql.replace(/\s+/g, ' ').trim().slice(0, 80));
      log([
        new Date().toISOString(), req.method, url.pathname, status, `${Date.now() - started}ms`,
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

function main() {
  const env = process.env;
  const say = (line) => console.log(`${new Date().toISOString()} ${line}`);

  const port = wholeNumber(env.SHOP_BRIDGE_PORT, 8787, 1, 65535);
  const intervalMinutes = wholeNumber(env.SHOP_MIRROR_INTERVAL_MINUTES, 15, 1, 10080);
  const maxRows = wholeNumber(env.SHOP_MIRROR_MAX_ROWS, DEFAULT_MIRROR_MAX_ROWS, 1, Number.MAX_SAFE_INTEGER);
  for (const [name, value, rule] of [
    ['SHOP_BRIDGE_PORT', port, 'a port number'],
    ['SHOP_MIRROR_INTERVAL_MINUTES', intervalMinutes, 'a whole number of minutes from 1 to 10080'],
    ['SHOP_MIRROR_MAX_ROWS', maxRows, 'a positive whole number'],
  ]) {
    if (value === null) {
      say(`${name} must be ${rule} (got ${JSON.stringify(env[name])}); not starting`);
      process.exitCode = 1;
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
    process.exitCode = 1;
    return;
  }
  const { queries } = loaded;
  say(`loaded ${queriesPath}: ${queries.mirror.length} mirror, ${Object.keys(queries.live).length} live`);

  let mirror = null;
  if (env.SHOP_MIRROR_DATABASE_URL) {
    mirror = createMirror({
      getPool: defaultGetPool,
      pgConnectionString: env.SHOP_MIRROR_DATABASE_URL,
      mirror: queries.mirror,
      maxRows,
      intervalMinutes,
    });
  } else {
    say('SHOP_MIRROR_DATABASE_URL is not set: the mirror is off');
  }
  if (!env.SHOP_BRIDGE_TOKEN || env.SHOP_BRIDGE_TOKEN.length < 32) {
    say('SHOP_BRIDGE_TOKEN is missing or shorter than 32 characters: /query/<name> answers 503');
  }

  const handler = createHandler({
    token: env.SHOP_BRIDGE_TOKEN,
    server: env.SHOP_DB_SERVER ?? null,
    database: env.SHOP_DB_NAME ?? null,
    mirrorStatus: () => (mirror ? mirror.status() : { enabled: false }),
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
