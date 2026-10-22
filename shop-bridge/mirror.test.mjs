import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMirror, createMirrorApi } from './mirror.mjs';
import { stubMirrorApi, stubPool } from './testing-stubs.mjs';

const ENTRIES = [
  { into: 'projects', sql: 'SELECT ID, Name, When, Blob FROM dbo.tblProject' },
  { into: 'locations', sql: 'SELECT ID, Name, When, Blob FROM dbo.tblLocation' },
  { into: 'contacts', sql: 'SELECT ID, Name, When, Blob FROM dbo.tblContact' },
];
const INTOS = ENTRIES.map((e) => e.into);
const COLUMNS = [
  { name: 'ID', type: 'int' },
  { name: 'Name', type: 'varchar' },
  { name: 'When', type: 'datetime' },
  { name: 'Blob', type: 'varbinary' },
];

const sourceTable = (sql) => /FROM dbo\.(\w+)/.exec(sql)[1];

function sourcePool(rowsByTable = {}) {
  return stubPool((sql) => {
    const table = sourceTable(sql);
    const rows = rowsByTable[table] ?? [{ ID: 1, Name: `${table} row`, When: new Date('2026-01-02T03:04:05Z'), Blob: Buffer.from([0xab, 0xcd]) }];
    return { columns: COLUMNS, rows };
  });
}

function setup({ entries = ENTRIES, pool = sourcePool(), api = stubMirrorApi(), maxRows } = {}) {
  const logs = [];
  const mirror = createMirror({
    getPool: async () => pool,
    api,
    mirror: entries,
    ...(maxRows === undefined ? {} : { maxRows }),
    intervalMinutes: 15,
    log: (l) => logs.push(l),
  });
  return { mirror, logs, api, pool };
}

const calls = (api) => api.calls.map((c) => `${c.fn}${c.table ? ` ${c.table}` : ''}`);

test('a run sends each entry with its columns and plain rows, then asks for the jobs refresh', async () => {
  const { mirror, api } = setup();
  assert.deepEqual(await mirror.runOnce(), { skipped: false, ok: true });
  assert.deepEqual(calls(api), [...INTOS.map((t) => `replace ${t}`), 'refresh']);
  assert.deepEqual(api.calls[0].columns, [
    { name: 'ID', type: 'integer' },
    { name: 'Name', type: 'text' },
    { name: 'When', type: 'timestamp' },
    { name: 'Blob', type: 'text' },
  ]);
  // Zone-less wall-clock dates and hex binary, as types.mjs plainValue makes them.
  assert.deepEqual(api.calls[0].rows, [{ ID: 1, Name: 'tblProject row', When: '2026-01-02T03:04:05.000', Blob: 'abcd' }]);
  const status = mirror.status();
  assert.equal(status.lastOk, true);
  assert.equal(status.lastError, null);
  assert.deepEqual(Object.keys(status.tables), INTOS);
  assert.deepEqual(status.tables.projects, { rowCount: 1, ok: true, finishedAt: status.tables.projects.finishedAt, error: null });
  assert.deepEqual(status.refreshJobs.result, { ok: true, upserted: 0 });
});

test('a source read failure is sent as that table\'s failure, and the other entries still run; long errors are cut to 500 chars', async () => {
  const pool = stubPool((sql) => (sql.includes('tblLocation')
    ? { error: new Error('x'.repeat(900)) }
    : { columns: ['ID'], rows: [{ ID: 1 }] }));
  const { mirror, api } = setup({ pool });
  assert.equal((await mirror.runOnce()).ok, false);
  assert.deepEqual(calls(api), ['replace projects', 'recordFailure locations', 'replace contacts', 'refresh']);
  assert.equal(api.calls[1].error.length, 500);
  assert.equal(mirror.status().tables.locations.ok, false);
  // The refresh itself decides whether to run on a failed dependency (shop.refresh_jobs()).
  assert.equal(mirror.status().lastError, null);
});

test('a copy Supabase reports as failed fails that entry with Supabase\'s reason', async () => {
  const api = stubMirrorApi({
    respond: (call) => (call.table === 'locations'
      ? { ok: false, error: 'landing table shop.locations has columns ["ID"] but the query returns ["ID","Name"]; drop table shop.locations in Supabase and the next run recreates it' }
      : { ok: true, row_count: call.rows.length }),
  });
  const { mirror } = setup({ api });
  assert.equal((await mirror.runOnce()).ok, false);
  const { locations, contacts } = mirror.status().tables;
  assert.equal(locations.ok, false);
  assert.match(locations.error, /drop table shop\.locations/);
  assert.equal(contacts.ok, true);
});

test('the row cap stops reading an oversized entry, which is sent as a failure; the others still run', async () => {
  const big = Array.from({ length: 5 }, (_, i) => ({ ID: i, Name: 'n', When: null, Blob: null }));
  const { mirror, api, pool } = setup({ pool: sourcePool({ tblLocation: big }), maxRows: 3 });
  assert.equal((await mirror.runOnce()).ok, false);
  assert.deepEqual(calls(api), ['replace projects', 'recordFailure locations', 'replace contacts', 'refresh']);
  assert.match(api.calls[1].error, /more than 3 rows \(SHOP_MIRROR_MAX_ROWS\); nothing was written/);
  assert.ok(pool.requests.find((r) => r.sql.includes('tblLocation')).cancelled);
});

test('time, datetimeoffset, and wide decimal columns fail that entry with the cast that fixes it', async () => {
  const cases = [
    { name: 'StartTime', type: 'time' },
    { name: 'Stamped At', type: 'datetimeoffset' },
    { name: 'Big', type: 'decimal', precision: 18, scale: 4 },
  ];
  for (const column of cases) {
    const pool = stubPool(() => ({ columns: ['ID', column], rows: [{ ID: 1, [column.name]: null }] }));
    const { mirror, api } = setup({ entries: [ENTRIES[0]], pool });
    assert.equal((await mirror.runOnce()).ok, false);
    assert.equal(api.calls[0].fn, 'recordFailure', column.type);
    assert.match(api.calls[0].error, /CONVERT\(/, column.type);
  }
});

test('money and decimals of up to 15 digits copy as they are; NUL characters are removed from text', async () => {
  const pool = stubPool(() => ({
    columns: [{ name: 'Price', type: 'money' }, { name: 'Qty', type: 'decimal', precision: 15, scale: 2 }, 'Name'],
    rows: [{ Price: 12.5, Qty: 3.25, Name: 'a\u0000b' }],
  }));
  const { mirror, api } = setup({ entries: [ENTRIES[0]], pool });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.deepEqual(api.calls[0].rows, [{ Price: 12.5, Qty: 3.25, Name: 'ab' }]);
  assert.deepEqual(api.calls[0].columns.map((c) => c.type), ['numeric', 'numeric', 'text']);
});

test('a nameless column, or two columns with the same name, fail that entry before anything is sent', async () => {
  for (const [behavior, reason] of [
    [() => ({ columns: [''], rows: [{ '': 1 }] }), /column with no name; name it with AS/],
    // mssql folds a repeated column name into one array-valued column.
    [() => ({ columns: ['ProjectID'], rows: [{ ProjectID: [1860, 12] }] }), /two columns with the same name/],
  ]) {
    const { mirror, api } = setup({ entries: [ENTRIES[0]], pool: stubPool(behavior) });
    await mirror.runOnce();
    assert.equal(api.calls[0].fn, 'recordFailure');
    assert.match(api.calls[0].error, reason);
  }
});

test('zero source rows: an empty copy is sent', async () => {
  const { mirror, api } = setup({ entries: [ENTRIES[0]], pool: sourcePool({ tblProject: [] }) });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.deepEqual(api.calls[0].rows, []);
});

test('an overlapping tick is skipped and logged', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = stubMirrorApi({ onCall: (call) => (call.table === 'projects' ? gate : undefined) });
  const { mirror, logs } = setup({ api });
  const first = mirror.runOnce();
  await new Promise((r) => setImmediate(r));
  assert.equal(mirror.status().inFlight, true);
  assert.deepEqual(await mirror.runOnce(), { skipped: true });
  assert.ok(logs.some((l) => /skipped: previous run still in flight/.test(l)));
  release();
  await first;
  assert.equal(api.calls.filter((c) => c.fn === 'refresh').length, 1);
  assert.equal(mirror.status().inFlight, false);
});

test('when Supabase cannot be reached or refuses the call, the reason is kept in status().lastError', async () => {
  const api = stubMirrorApi({
    respond: () => { throw new Error('Supabase refused the call (HTTP 401: shop mirror token refused)'); },
  });
  const { mirror } = setup({ api });
  assert.deepEqual(await mirror.runOnce(), { skipped: false, ok: false });
  const status = mirror.status();
  assert.match(status.lastError, /HTTP 401: shop mirror token refused/);
  assert.equal(status.tables.projects.ok, false);
  assert.match(status.tables.projects.error, /HTTP 401/);
  assert.equal(status.refreshJobs.ok, false);
});

test('a refresh call that fails keeps its reason in status().lastError', async () => {
  const api = stubMirrorApi({ refresh: () => { throw new Error('could not reach Supabase (no answer within 60 s)'); } });
  const { mirror } = setup({ api });
  assert.deepEqual(await mirror.runOnce(), { skipped: false, ok: false });
  assert.equal(mirror.status().refreshJobs.ok, false);
  assert.match(mirror.status().lastError, /no answer within 60 s/);
});

test('a copy that never reached Supabase skips the jobs refresh, which would read that table\'s previous copy', async () => {
  const api = stubMirrorApi({
    respond: (call) => {
      if (call.table === 'locations') throw new Error('could not reach Supabase (no answer within 60 s)');
      return { ok: true, row_count: call.rows.length };
    },
  });
  const { mirror, logs } = setup({ api });
  assert.equal((await mirror.runOnce()).ok, false);
  assert.deepEqual(calls(api), INTOS.map((t) => `replace ${t}`));
  const { refreshJobs } = mirror.status();
  assert.equal(refreshJobs.ok, false);
  assert.equal(refreshJobs.result, null);
  assert.match(refreshJobs.error, /^skipped/);
  assert.ok(logs.some((l) => /refresh_jobs skipped/.test(l)));
});

test('a refresh Supabase reports as failed marks the run failed and exposes the result', async () => {
  const result = { ok: false, error: 'not refreshed: the latest copy of shop.open_jobs did not succeed' };
  const { mirror, logs } = setup({ api: stubMirrorApi({ refresh: () => result }) });
  assert.equal((await mirror.runOnce()).ok, false);
  assert.deepEqual(mirror.status().refreshJobs.result, result);
  assert.equal(mirror.status().lastError, null);
  assert.ok(logs.some((l) => /refresh_jobs FAILED/.test(l)));
});

// --- the HTTPS client ------------------------------------------------------------------

function fakeFetch(answer) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const { status = 200, body = { ok: true, row_count: 0 }, throws } = typeof answer === 'function' ? answer(url, init) : (answer ?? {});
    if (throws) throw throws;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { impl, requests };
}

const TOKEN = 'a'.repeat(64);

test('the client posts each call to its RPC with the anon key, the token, and a deadline', async () => {
  const fetch = fakeFetch();
  const api = createMirrorApi({ supabaseUrl: 'https://ref.supabase.co/', apiKey: 'sb_publishable_x', token: TOKEN, fetchImpl: fetch.impl });
  await api.replace('projects', [{ name: 'ID', type: 'integer' }], [{ ID: 1 }]);
  await api.recordFailure('locations', 'SQL Server: timeout');
  await api.refresh();
  assert.deepEqual(fetch.requests.map((r) => r.url), [
    'https://ref.supabase.co/rest/v1/rpc/shop_mirror_replace',
    'https://ref.supabase.co/rest/v1/rpc/shop_mirror_replace',
    'https://ref.supabase.co/rest/v1/rpc/shop_mirror_refresh',
  ]);
  assert.deepEqual(fetch.requests.map((r) => r.body), [
    { p_token: TOKEN, p_table: 'projects', p_columns: [{ name: 'ID', type: 'integer' }], p_rows: [{ ID: 1 }] },
    { p_token: TOKEN, p_table: 'locations', p_error: 'SQL Server: timeout' },
    { p_token: TOKEN },
  ]);
  const { init } = fetch.requests[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.apikey, 'sb_publishable_x');
  assert.equal(init.headers.authorization, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, 'error');
  // A legacy anon key is a JWT, which also goes in Authorization.
  const legacy = fakeFetch();
  await createMirrorApi({ supabaseUrl: 'https://ref.supabase.co', apiKey: 'h.p.s', token: TOKEN, fetchImpl: legacy.impl }).refresh();
  assert.equal(legacy.requests[0].init.headers.authorization, 'Bearer h.p.s');
});

test('the client names a refused token, other HTTP errors, unreachable hosts, timeouts, and non-JSON answers', async () => {
  const make = (answer) => createMirrorApi({ supabaseUrl: 'https://ref.supabase.co', apiKey: 'k', token: TOKEN, fetchImpl: fakeFetch(answer).impl, timeoutMs: 5000 });
  await assert.rejects(make({ status: 401, body: { code: '42501', message: 'shop mirror token refused' } }).refresh(),
    /HTTP 401: shop mirror token refused.*SHOP_MIRROR_TOKEN/);
  await assert.rejects(make({ status: 400, body: { message: 'shop_mirror_replace: x is not a mirror table name' } }).refresh(),
    /HTTP 400: shop_mirror_replace: x is not a mirror table name/);
  await assert.rejects(make({ status: 502, body: '<html>bad gateway</html>' }).refresh(), /HTTP 502: <html>bad gateway/);
  await assert.rejects(make({ throws: Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND ref.supabase.co') }) }).refresh(),
    /could not reach Supabase \(getaddrinfo ENOTFOUND ref\.supabase\.co\)/);
  await assert.rejects(make({ throws: new DOMException('The operation timed out.', 'TimeoutError') }).refresh(),
    /could not reach Supabase \(no answer within 5 s\)/);
  await assert.rejects(make({ status: 200, body: 'not json' }).refresh(), /HTTP 200 without a JSON result/);
});
