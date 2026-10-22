import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, test } from 'node:test';
import { createHandler, mirrorSettingsProblem, wholeNumber } from './server.mjs';
import { mssqlError, stubPool } from './testing-stubs.mjs';

const TOKEN = 'a'.repeat(64);
const servers = [];

async function serve(deps) {
  const logs = [];
  const server = http.createServer(createHandler({ log: (l) => logs.push(l), live: LIVE, ...deps }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    logs,
    port,
    async call(method, path, { body, token = TOKEN, raw } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(base + path, {
        method,
        headers,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return { status: res.status, headers: res.headers, json: await res.json() };
    },
  };
}

after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const LIVE = {
  projects_by_archived: 'select ProjectID, Project\n  from dbo.tblProject where Archived = @archived',
  all_projects: 'select ProjectID, Project from dbo.tblProject',
};
const Q = '/query/projects_by_archived';
const ALL = '/query/all_projects';

const projects = (n) => Array.from({ length: n }, (_, i) => ({ ProjectID: i + 1, Project: `Job ${i + 1}` }));
const okPool = (rows = projects(3)) =>
  stubPool(() => ({ columns: ['ProjectID', 'Project'], rows }));

test('503 not_configured when the token is unset or short', async () => {
  for (const token of [undefined, '', 'short-token']) {
    const { call } = await serve({ token, getPool: async () => okPool() });
    const res = await call('POST', Q, { body: {} });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'not_configured');
  }
});

test('401 unauthorized on missing, wrong, or different-length bearer, for known and unknown names alike', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  for (const path of [Q, '/query/nope', '/query/bad-name']) {
    for (const token of [null, 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'x']) {
      const res = await call('POST', path, { body: {}, token });
      assert.equal(res.status, 401, `${path} token ${token}`);
      assert.deepEqual(res.json.error.code, 'unauthorized');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  }
});

test('413 payload_too_large over 64 KiB', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const res = await call('POST', Q, { body: { params: { archived: 'x'.repeat(70 * 1024) } } });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'payload_too_large');
});

test('400 bad_request on malformed input, including any attempt to send SQL', async () => {
  let poolCalls = 0;
  const { call } = await serve({ token: TOKEN, getPool: async () => { poolCalls++; return okPool(); } });
  const cases = [
    { raw: '{not json' },
    { raw: '[]' },
    { raw: 'null' },
    { body: { sql: 'select 1' } },
    { body: { params: [] } },
    { body: { params: { 'bad name': 1 } } },
    { body: { params: { a: { nested: true } } } },
    { body: { maxRows: 0 } },
    { body: { maxRows: 'many' } },
  ];
  for (const c of cases) {
    const res = await call('POST', Q, c);
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.equal(res.json.error.code, 'bad_request');
  }
  const sql = await call('POST', Q, { body: { sql: 'select 1' } });
  assert.match(sql.json.error.message, /"sql"/);
  assert.equal(poolCalls, 0);
});

test('200: a named live query runs its own statement with bound params', async () => {
  const pool = okPool();
  const { call, logs } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', Q, { body: { params: { archived: false, name: 'x', n: 2, z: null } } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.columns, ['ProjectID', 'Project']);
  assert.deepEqual(res.json.rows, projects(3));
  assert.equal(res.json.rowCount, 3);
  assert.equal(res.json.truncated, false);
  assert.equal(typeof res.json.durationMs, 'number');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(pool.requests[0].sql, LIVE.projects_by_archived);
  assert.deepEqual(pool.requests[0].inputs, { archived: false, name: 'x', n: 2, z: null });
  assert.equal(pool.requests[0].stream, true);
  const line = logs.at(-1);
  assert.match(line, /POST \/query\/projects_by_archived 200 \d+ms rows=3 truncated=false name=projects_by_archived sql="select ProjectID, Project from dbo\.tblProject where Archived = @archived"/);
});

test('an empty body or {} is allowed', async () => {
  const pool = okPool();
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  for (const c of [{ raw: '' }, { body: {} }, { raw: '  ' }]) {
    const res = await call('POST', ALL, c);
    assert.equal(res.status, 200, JSON.stringify(c));
    assert.equal(res.json.rowCount, 3);
  }
  assert.ok(pool.requests.every((r) => r.sql === LIVE.all_projects));
});

test('truncates at maxRows, cancels the request, and caps at 50,000', async () => {
  const pool = okPool(projects(12));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', ALL, { body: { maxRows: 5 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.rowCount, 5);
  assert.equal(res.json.rows.length, 5);
  assert.equal(res.json.truncated, true);
  assert.equal(pool.requests[0].cancelled, true);

  const exact = await call('POST', ALL, { body: { maxRows: 12 } });
  assert.equal(exact.json.truncated, false);
  assert.equal(exact.json.rowCount, 12);

  const capped = await call('POST', ALL, { body: { maxRows: 10_000_000 } });
  assert.equal(capped.status, 200);
  assert.equal(capped.json.rowCount, 12);
});

test('defaults maxRows to 5,000', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool(projects(5001)) });
  const res = await call('POST', ALL);
  assert.equal(res.json.rowCount, 5000);
  assert.equal(res.json.truncated, true);
});

test('404 not_found for an unknown or malformed name, only after auth', async () => {
  let poolCalls = 0;
  const { call } = await serve({ token: TOKEN, getPool: async () => { poolCalls++; return okPool(); } });
  const unknown = await call('POST', '/query/nope', { body: {} });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: { code: 'not_found', message: 'No live query named "nope".' } });
  for (const path of ['/query/bad-name', '/query/a%20b', '/query/a/b', '/query/', '/query/__proto__', '/query/constructor', '/query/toString']) {
    const res = await call('POST', path, { body: {} });
    assert.equal(res.status, 404, path);
    assert.equal(res.json.error.code, 'not_found');
  }
  assert.equal(poolCalls, 0);
});

test('POST /query without a name and GET on a query path answer 404', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const bare = await call('POST', '/query', { body: { sql: 'select 1' } });
  assert.equal(bare.status, 404);
  assert.deepEqual(bare.json.error, { code: 'not_found', message: 'No route for POST /query.' });
  const getNamed = await call('GET', Q);
  assert.equal(getNamed.status, 404);
});

test('a malformed request URL is a 400, not a crash', async () => {
  const { port, logs, call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.match(reply, /"Invalid request URL\."/);
  assert.ok(logs.some((l) => / GET \(invalid URL\) 400 /.test(l)));
  // The server is still up.
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('rows come back with zone-less timestamps, hex for binary, and no NUL characters', async () => {
  const pool = stubPool(() => ({
    columns: ['When', 'Blob', 'Name'],
    rows: [{ When: new Date('2026-01-02T09:00:00Z'), Blob: Buffer.from([0xab]), Name: 'a\u0000b' }],
  }));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', ALL);
  assert.deepEqual(res.json.rows, [{ When: '2026-01-02T09:00:00.000', Blob: 'ab', Name: 'ab' }]);
});

test('an unexpected error is a 500 with a generic body; the log has the code, message, and stack', async () => {
  const { call, logs } = await serve({ token: TOKEN, getPool: async () => { throw new TypeError('boom'); } });
  const res = await call('POST', ALL);
  assert.equal(res.status, 500);
  assert.deepEqual(res.json.error, { code: 'internal_error', message: 'Unexpected error in the bridge.' });
  assert.ok(logs.some((l) => / error 500: code=- message="boom"$/.test(l)));
  assert.ok(logs.some((l) => l.startsWith('TypeError: boom')));
});

test('504 timeout when the request times out, with the driver\'s reason in the log', async () => {
  // The bridge's own deadline is tested in query.test.mjs; here the driver reports the timeout.
  const pool = stubPool(() => ({ error: mssqlError('ETIMEOUT') }));
  const { call, logs } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', ALL);
  assert.equal(res.status, 504);
  assert.deepEqual(res.json.error, { code: 'timeout', message: 'The query ran longer than 30 seconds and was cancelled.' });
  assert.ok(logs.some((l) => l.endsWith('error 504: code=ETIMEOUT message="stub ETIMEOUT"')));
});

test('502 db_unreachable on connection errors', async () => {
  for (const err of [mssqlError('ECONNREFUSED', 'Error'), mssqlError('ELOGIN', 'ConnectionError'), mssqlError('ETIMEOUT', 'ConnectionError')]) {
    // The connect itself fails (getPool rejects) ...
    const a = await serve({ token: TOKEN, getPool: async () => { throw err; } });
    const resA = await a.call('POST', ALL);
    assert.equal(resA.status, 502, `${err.name} ${err.code}`);
    assert.equal(resA.json.error.code, 'db_unreachable');
    // ... or the request fails on a dropped connection.
    const b = await serve({ token: TOKEN, getPool: async () => stubPool(() => ({ error: err })) });
    const resB = await b.call('POST', ALL);
    assert.equal(resB.status, 502);
  }
});

test('SQL errors from the server are 400 bad_request with the message', async () => {
  const pool = stubPool(() => ({ error: Object.assign(new Error("Must declare the scalar variable \"@archived\"."), { code: 'EREQUEST', name: 'RequestError' }) }));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', Q);
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
  assert.match(res.json.error.message, /Must declare the scalar variable/);
});

test('health without auth, with SQL reachable, lists the query names', async () => {
  const pool = stubPool(() => ({ columns: ['version'], rows: [{ version: 'Microsoft SQL Server 2016 (SP3)\n\tCopyright' }] }));
  const { call } = await serve({
    token: TOKEN, getPool: async () => pool, server: 'SQL2016\\SQLEXPRESS', database: 'DWS',
    mirrorStatus: () => ({ enabled: true, lastRunAt: null, lastOk: null, inFlight: false, tables: {} }),
    mirrorNames: ['projects', 'contacts'],
  });
  const res = await call('GET', '/health', { token: null });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.version, 'Microsoft SQL Server 2016 (SP3)');
  assert.equal(pool.requests[0].sql, 'SELECT @@VERSION AS version');
  assert.equal(pool.requests[0].stream, true);
  assert.equal(res.json.server, 'SQL2016\\SQLEXPRESS');
  assert.equal(res.json.database, 'DWS');
  assert.equal(res.json.mirror.enabled, true);
  assert.deepEqual(res.json.queries, { mirror: ['projects', 'contacts'], live: ['projects_by_archived', 'all_projects'] });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('health is 502 when SQL is unreachable, and the mirror can be off', async () => {
  const { call, logs } = await serve({ token: undefined, live: {}, getPool: async () => { throw mssqlError('ESOCKET', 'ConnectionError'); } });
  const res = await call('GET', '/health', { token: null });
  assert.equal(res.status, 502);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'db_unreachable');
  assert.deepEqual(res.json.mirror, { enabled: false });
  assert.deepEqual(res.json.queries, { mirror: [], live: [] });
  // The log keeps the driver's reason, which the response only summarises.
  assert.ok(logs.some((l) => / error 502: code=ESOCKET message="stub ESOCKET"$/.test(l)));
});

test('health maps a missing SHOP_DB_SERVER or SHOP_DB_NAME to 503 not_configured, not 502', async () => {
  for (const name of ['SHOP_DB_SERVER', 'SHOP_DB_NAME']) {
    const configError = Object.assign(new Error(`${name} is not set`), { code: 'ECONFIG' });
    const { call, logs } = await serve({ token: TOKEN, live: {}, getPool: async () => { throw configError; } });
    const res = await call('GET', '/health', { token: null });
    assert.equal(res.status, 503);
    assert.deepEqual(res.json.error, { code: 'not_configured', message: `The bridge is not configured: ${name} is not set.` });
    assert.ok(logs.some((l) => l.endsWith(`error 503: code=ECONFIG message="${name} is not set"`)));
  }
});

test('wholeNumber: settings are whole numbers in range, with a fallback when unset', () => {
  assert.equal(wholeNumber(undefined, 15, 1, 10080), 15);
  assert.equal(wholeNumber('', 15, 1, 10080), 15);
  assert.equal(wholeNumber('30', 15, 1, 10080), 30);
  for (const bad of ['0', '-5', '15m', '1.5', 'NaN', '10081']) assert.equal(wholeNumber(bad, 15, 1, 10080), null, bad);
  assert.equal(wholeNumber('65536', 8787, 1, 65535), null);
});

test('mirrorSettingsProblem: an https Supabase URL, an API key, and a token of 32+ characters', () => {
  const good = { SHOP_MIRROR_SUPABASE_URL: 'https://ref.supabase.co', SHOP_MIRROR_API_KEY: 'sb_publishable_x', SHOP_MIRROR_TOKEN: TOKEN };
  assert.equal(mirrorSettingsProblem(good), null);
  assert.equal(mirrorSettingsProblem({ ...good, SHOP_MIRROR_SUPABASE_URL: 'http://127.0.0.1:54321' }), null);
  assert.match(mirrorSettingsProblem({ ...good, SHOP_MIRROR_SUPABASE_URL: 'ref.supabase.co' }), /is not a URL/);
  assert.match(mirrorSettingsProblem({ ...good, SHOP_MIRROR_SUPABASE_URL: 'http://ref.supabase.co' }), /must start with https:\/\//);
  assert.match(mirrorSettingsProblem({ ...good, SHOP_MIRROR_API_KEY: ' ' }), /SHOP_MIRROR_API_KEY is not set/);
  assert.match(mirrorSettingsProblem({ ...good, SHOP_MIRROR_TOKEN: 'short' }), /SHOP_MIRROR_TOKEN is missing or shorter than 32/);
});
