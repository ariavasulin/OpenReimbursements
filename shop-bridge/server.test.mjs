import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { createHandler } from './server.mjs';
import { mssqlError, stubPool } from './testing-stubs.mjs';

const TOKEN = 'a'.repeat(64);
const servers = [];

async function serve(deps) {
  const logs = [];
  const server = http.createServer(createHandler({ log: (l) => logs.push(l), ...deps }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    logs,
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

const projects = (n) => Array.from({ length: n }, (_, i) => ({ ProjectID: i + 1, Project: `Job ${i + 1}` }));
const okPool = (rows = projects(3)) =>
  stubPool(() => ({ columns: ['ProjectID', 'Project'], rows }));

test('503 not_configured when the token is unset or short', async () => {
  for (const token of [undefined, '', 'short-token']) {
    const { call } = await serve({ token, getPool: async () => okPool() });
    const res = await call('POST', '/query', { body: { sql: 'select 1' } });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'not_configured');
  }
});

test('401 unauthorized on missing, wrong, or different-length bearer', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  for (const token of [null, 'b'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'x']) {
    const res = await call('POST', '/query', { body: { sql: 'select 1' }, token });
    assert.equal(res.status, 401, `token ${token}`);
    assert.deepEqual(res.json.error.code, 'unauthorized');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('413 payload_too_large over 64 KiB', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const res = await call('POST', '/query', { body: { sql: `select '${'x'.repeat(70 * 1024)}'` } });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'payload_too_large');
});

test('400 not_read_only from the guard, before any database call', async () => {
  let poolCalls = 0;
  const { call } = await serve({ token: TOKEN, getPool: async () => { poolCalls++; return okPool(); } });
  const res = await call('POST', '/query', { body: { sql: 'update tblProject set Project = 1' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'not_read_only');
  assert.match(res.json.error.message, /single SELECT/);
  assert.equal(poolCalls, 0);
});

test('400 bad_request on malformed input', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const cases = [
    { raw: '{not json' },
    { body: { params: {} } },
    { body: { sql: 'select 1', params: { 'bad name': 1 } } },
    { body: { sql: 'select 1', params: { a: { nested: true } } } },
    { body: { sql: 'select 1', maxRows: 0 } },
    { body: { sql: 'select 1', maxRows: 'many' } },
  ];
  for (const c of cases) {
    const res = await call('POST', '/query', c);
    assert.equal(res.status, 400, JSON.stringify(c));
    assert.equal(res.json.error.code, 'bad_request');
  }
});

test('200 with columns, rows, and bound params', async () => {
  const pool = okPool();
  const { call, logs } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', '/query', {
    body: { sql: 'select ProjectID, Project\n  from tblProject where Archived = @archived', params: { archived: false, name: 'x', n: 2, z: null } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.columns, ['ProjectID', 'Project']);
  assert.deepEqual(res.json.rows, projects(3));
  assert.equal(res.json.rowCount, 3);
  assert.equal(res.json.truncated, false);
  assert.equal(typeof res.json.durationMs, 'number');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(pool.requests[0].inputs, { archived: false, name: 'x', n: 2, z: null });
  assert.equal(pool.requests[0].stream, true);
  const line = logs.at(-1);
  assert.match(line, /POST \/query 200 \d+ms rows=3 truncated=false sql="select ProjectID, Project from tblProject where Archived = @archived"/);
});

test('truncates at maxRows, cancels the request, and caps at 50,000', async () => {
  const pool = okPool(projects(12));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', '/query', { body: { sql: 'select * from tblProject', maxRows: 5 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.rowCount, 5);
  assert.equal(res.json.rows.length, 5);
  assert.equal(res.json.truncated, true);
  assert.equal(pool.requests[0].cancelled, true);

  const exact = await call('POST', '/query', { body: { sql: 'select * from tblProject', maxRows: 12 } });
  assert.equal(exact.json.truncated, false);
  assert.equal(exact.json.rowCount, 12);

  const capped = await call('POST', '/query', { body: { sql: 'select * from tblProject', maxRows: 10_000_000 } });
  assert.equal(capped.status, 200);
  assert.equal(capped.json.rowCount, 12);
});

test('defaults maxRows to 5,000', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool(projects(5001)) });
  const res = await call('POST', '/query', { body: { sql: 'select * from tblProject' } });
  assert.equal(res.json.rowCount, 5000);
  assert.equal(res.json.truncated, true);
});

test('504 timeout when the request times out', async () => {
  const pool = stubPool(() => ({ error: mssqlError('ETIMEOUT') }));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', '/query', { body: { sql: 'select 1' } });
  assert.equal(res.status, 504);
  assert.equal(res.json.error.code, 'timeout');
});

test('502 db_unreachable on connection errors', async () => {
  for (const err of [mssqlError('ECONNREFUSED', 'Error'), mssqlError('ELOGIN', 'ConnectionError'), mssqlError('ETIMEOUT', 'ConnectionError')]) {
    // The connect itself fails (getPool rejects) ...
    const a = await serve({ token: TOKEN, getPool: async () => { throw err; } });
    const resA = await a.call('POST', '/query', { body: { sql: 'select 1' } });
    assert.equal(resA.status, 502, `${err.name} ${err.code}`);
    assert.equal(resA.json.error.code, 'db_unreachable');
    // ... or the request fails on a dropped connection.
    const b = await serve({ token: TOKEN, getPool: async () => stubPool(() => ({ error: err })) });
    const resB = await b.call('POST', '/query', { body: { sql: 'select 1' } });
    assert.equal(resB.status, 502);
  }
});

test('SQL errors from the server are 400 bad_request with the message', async () => {
  const pool = stubPool(() => ({ error: Object.assign(new Error("Invalid column name 'Nope'."), { code: 'EREQUEST', name: 'RequestError' }) }));
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });
  const res = await call('POST', '/query', { body: { sql: 'select Nope from tblProject' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'bad_request');
  assert.match(res.json.error.message, /Invalid column name/);
});

test('health without auth, with SQL reachable', async () => {
  const pool = stubPool(() => ({ columns: ['version'], rows: [{ version: 'Microsoft SQL Server 2016 (SP3)\n\tCopyright' }] }));
  const { call } = await serve({
    token: TOKEN, getPool: async () => pool, server: 'SQL2016\\SQLEXPRESS', database: 'DWS',
    mirrorStatus: () => ({ enabled: true, lastRunAt: null, lastOk: null, inFlight: false, tables: {} }),
  });
  const res = await call('GET', '/health', { token: null });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.version, 'Microsoft SQL Server 2016 (SP3)');
  assert.equal(res.json.server, 'SQL2016\\SQLEXPRESS');
  assert.equal(res.json.database, 'DWS');
  assert.equal(res.json.mirror.enabled, true);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('health is 502 when SQL is unreachable, and the mirror can be off', async () => {
  const { call } = await serve({ token: undefined, getPool: async () => { throw mssqlError('ESOCKET', 'ConnectionError'); } });
  const res = await call('GET', '/health', { token: null });
  assert.equal(res.status, 502);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'db_unreachable');
  assert.deepEqual(res.json.mirror, { enabled: false });
});

test('404 not_found for unknown routes', async () => {
  const { call } = await serve({ token: TOKEN, getPool: async () => okPool() });
  const res = await call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
});

test('GET /ddl returns create table SQL for the named tables', async () => {
  const meta = {
    tblPM: {
      columns: [
        { COLUMN_NAME: 'PMID', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
        { COLUMN_NAME: 'PMName', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES' },
      ],
      pk: [{ COLUMN_NAME: 'PMID' }],
    },
  };
  const pool = stubPool((sql, request) => {
    const table = meta[request.inputs.table];
    if (/PRIMARY KEY/.test(sql)) return { columns: ['COLUMN_NAME'], rows: table?.pk ?? [] };
    return { columns: ['COLUMN_NAME', 'DATA_TYPE', 'IS_NULLABLE'], rows: table?.columns ?? [] };
  });
  const { call } = await serve({ token: TOKEN, getPool: async () => pool });

  const res = await call('GET', '/ddl?tables=tblPM');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.tables, ['tblPM']);
  assert.ok(res.json.sql.includes(
    'create table if not exists shop."tblPM" (\n  "PMID" integer not null,\n  "PMName" text,\n  primary key ("PMID")\n);',
  ));
  assert.match(res.json.sql, /grant select, insert, delete on shop\."tblPM" to shop_mirror;/);

  const unknown = await call('GET', '/ddl?tables=tblPM,tblNope');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'bad_request');
  assert.match(unknown.json.error.message, /tblNope/);

  const badName = await call('GET', '/ddl?tables=tblPM,dbo.x');
  assert.equal(badName.status, 400);
  assert.match(badName.json.error.message, /dbo\.x/);

  const none = await call('GET', '/ddl');
  assert.equal(none.status, 400);

  const noAuth = await call('GET', '/ddl?tables=tblPM', { token: 'wrong' });
  assert.equal(noAuth.status, 401);
});
