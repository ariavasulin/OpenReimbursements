import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInsertBatches, createMirror, DEFAULT_MIRROR_MAX_ROWS, pgClientConfig } from './mirror.mjs';
import { stubPgClient, stubPool } from './testing-stubs.mjs';

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
const NAMES = COLUMNS.map((c) => c.name);
const CA = '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n';

const sourceTable = (sql) => /FROM dbo\.(\w+)/.exec(sql)[1];

function sourcePool(rowsByTable = {}) {
  return stubPool((sql) => {
    const table = sourceTable(sql);
    const rows = rowsByTable[table] ?? [{ ID: 1, Name: `${table} row`, When: new Date('2026-01-02T03:04:05Z'), Blob: Buffer.from([0xab, 0xcd]) }];
    return { columns: COLUMNS, rows };
  });
}

function setup({ entries = ENTRIES, pool = sourcePool(), clientOpts, maxRows } = {}) {
  const logs = [];
  const clients = [];
  const mirror = createMirror({
    getPool: async () => pool,
    pgConnectionString: 'postgresql://shop_mirror:pw@pooler.example.com:5432/postgres?sslmode=require',
    ca: CA,
    mirror: entries,
    ...(maxRows === undefined ? {} : { maxRows }),
    intervalMinutes: 15,
    log: (l) => logs.push(l),
    createPgClient: (connectionString, ca) => {
      assert.equal(ca, CA);
      const c = stubPgClient(clientOpts);
      clients.push(c);
      return c;
    },
  });
  return { mirror, logs, clients, pool };
}

// Short labels for the pg statements, in order.
const label = (text) => (text.startsWith('select column_name from information_schema.columns') ? 'COLUMNS' : text.split(' (')[0]);
const texts = (client) => client.queries.map((q) => label(q.text));
const syncRuns = (client) => client.queries.filter((q) => q.text.startsWith('INSERT INTO shop.sync_runs'));
const steps = (into) => [
  `create table if not exists shop."${into}"`, 'COLUMNS',
  'BEGIN', `DELETE FROM shop."${into}"`, `insert into shop."${into}"`, 'COMMIT', 'INSERT INTO shop.sync_runs',
];

test('first run: creates each landing table, copies in one transaction, records sync_runs, then refresh_jobs', async () => {
  const { mirror, clients, pool } = setup();
  const result = await mirror.runOnce();
  assert.deepEqual(result, { skipped: false, ok: true });
  assert.equal(clients.length, 1);
  const [client] = clients;
  assert.ok(client.connected && client.ended);

  // Exactly the statements from the config, nothing else, on SQL Server, streamed.
  assert.deepEqual(pool.requests.map((r) => r.sql), ENTRIES.map((e) => e.sql));
  assert.ok(pool.requests.every((r) => r.stream === true));
  assert.deepEqual(texts(client), [...INTOS.flatMap(steps), 'SELECT shop.refresh_jobs() AS result']);

  const create = client.queries.find((q) => q.text.startsWith('create table if not exists shop."projects"'));
  assert.equal(
    create.text,
    'create table if not exists shop."projects" (\n  "ID" integer,\n  "Name" text,\n  "When" timestamp,\n  "Blob" text\n);',
  );
  const lookup = client.queries.find((q) => label(q.text) === 'COLUMNS');
  assert.equal(
    lookup.text,
    "select column_name from information_schema.columns where table_schema = 'shop' and table_name = $1 order by ordinal_position",
  );
  assert.deepEqual(lookup.values, ['projects']);
  assert.deepEqual(client.tables, { projects: NAMES, locations: NAMES, contacts: NAMES });

  const insert = client.queries.find((q) => q.text.startsWith('insert into shop."projects"'));
  assert.equal(insert.text, 'insert into shop."projects" ("ID", "Name", "When", "Blob") values ($1, $2, $3, $4)');
  assert.equal(insert.values[2], '2026-01-02T03:04:05.000'); // wall clock, no zone
  assert.equal(insert.values[3], 'abcd'); // Buffer -> hex

  const runs = syncRuns(client);
  assert.equal(runs.length, ENTRIES.length);
  for (const [i, run] of runs.entries()) {
    const [table, startedAt, finishedAt, rowCount, ok, error] = run.values;
    assert.equal(table, INTOS[i]);
    assert.ok(startedAt instanceof Date && finishedAt instanceof Date);
    assert.equal(rowCount, 1);
    assert.equal(ok, true);
    assert.equal(error, null);
  }
  // refresh_jobs writes its own sync_runs row; the mirror does not add one for public.jobs.
  assert.ok(!runs.some((r) => r.values[0] === 'public.jobs'));

  const status = mirror.status();
  assert.equal(status.lastOk, true);
  assert.equal(status.inFlight, false);
  assert.ok(status.lastRunAt);
  assert.deepEqual(Object.keys(status.tables), INTOS);
  assert.equal(status.tables.projects.rowCount, 1);
  assert.equal(status.tables.projects.ok, true);
});

test('an existing landing table with the same columns is reused', async () => {
  const tables = { projects: [...NAMES] };
  const { mirror, clients } = setup({ entries: [ENTRIES[0]], clientOpts: { tables } });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.deepEqual(texts(clients[0]).slice(0, 7), steps('projects'));
  assert.deepEqual(tables.projects, NAMES);
});

test('a landing table whose columns differ fails that entry only, recorded in sync_runs; nothing is dropped', async () => {
  const tables = { locations: ['ID', 'Name'] };
  const { mirror, clients, logs } = setup({ clientOpts: { tables } });
  const result = await mirror.runOnce();
  assert.equal(result.ok, false);
  const [client] = clients;
  assert.deepEqual(texts(client), [
    ...steps('projects'),
    'create table if not exists shop."locations"', 'COLUMNS', 'INSERT INTO shop.sync_runs',
    ...steps('contacts'),
    'SELECT shop.refresh_jobs() AS result',
  ]);
  assert.ok(!client.queries.some((q) => /^(drop|alter)\b/i.test(q.text)));

  const message =
    'landing table shop.locations has columns ["ID","Name"] but the query returns ["ID","Name","When","Blob"]; ' +
    'drop table shop.locations in Supabase and the next run recreates it';
  const failed = syncRuns(client)[1].values;
  assert.equal(failed[0], 'locations');
  assert.equal(failed[3], null);
  assert.equal(failed[4], false);
  assert.equal(failed[5], message);
  assert.ok(logs.some((l) => l.includes('locations FAILED') && l.includes('drop table shop.locations in Supabase')));

  const status = mirror.status();
  assert.equal(status.lastOk, false);
  assert.equal(status.tables.locations.ok, false);
  assert.equal(status.tables.locations.error, message);
  assert.equal(status.tables.projects.ok, true);
  assert.equal(status.tables.contacts.ok, true);
});

test('the column comparison is exact: case and order both count', async () => {
  for (const existing of [['id', 'Name', 'When', 'Blob'], ['Name', 'ID', 'When', 'Blob']]) {
    const { mirror, clients } = setup({ entries: [ENTRIES[0]], clientOpts: { tables: { projects: existing } } });
    assert.equal((await mirror.runOnce()).ok, false);
    assert.match(syncRuns(clients[0])[0].values[5], /^landing table shop\.projects has columns \[/);
    assert.ok(!texts(clients[0]).includes('BEGIN'));
  }
});

test('the row cap stops reading an oversized entry and fails it before anything is written; the others still run', async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ ID: i, Name: 'x', When: null, Blob: null }));
  const pool = sourcePool({ tblProject: rows(3), tblLocation: rows(2), tblContact: rows(1) });
  const { mirror, clients } = setup({ pool, maxRows: 2 });
  const result = await mirror.runOnce();
  assert.equal(result.ok, false);
  const [client] = clients;
  assert.deepEqual(texts(client), [
    'INSERT INTO shop.sync_runs',
    ...steps('locations'),
    ...steps('contacts'),
    'SELECT shop.refresh_jobs() AS result',
  ]);
  const [projects, locations] = syncRuns(client).map((r) => r.values);
  assert.equal(projects[4], false);
  assert.equal(projects[5], 'the query returned more than 2 rows (SHOP_MIRROR_MAX_ROWS); nothing was written');
  assert.equal(pool.requests[0].cancelled, true); // stopped at row 3 instead of reading the whole result
  assert.equal(locations[3], 2); // exactly at the cap is fine
  assert.equal(pool.requests[1].cancelled, false);
  assert.equal(DEFAULT_MIRROR_MAX_ROWS, 100000);
});

test('one insert fails: it rolls back and is recorded, the others commit, refresh_jobs still runs', async () => {
  const { mirror, clients } = setup({
    clientOpts: {
      fail: (text) => (text.startsWith('insert into shop."locations"') ? new Error('column "Gone" does not exist') : null),
    },
  });
  const result = await mirror.runOnce();
  assert.equal(result.ok, false);
  const [client] = clients;
  assert.deepEqual(texts(client), [
    ...steps('projects'),
    'create table if not exists shop."locations"', 'COLUMNS',
    'BEGIN', 'DELETE FROM shop."locations"', 'insert into shop."locations"', 'ROLLBACK', 'INSERT INTO shop.sync_runs',
    ...steps('contacts'),
    'SELECT shop.refresh_jobs() AS result',
  ]);
  const failed = syncRuns(client)[1].values;
  assert.equal(failed[0], 'locations');
  assert.equal(failed[4], false);
  assert.equal(failed[5], 'column "Gone" does not exist');
});

test('a source read failure is recorded without touching Postgres; long errors are cut to 500 chars', async () => {
  const pool = stubPool((sql) => (sql.includes('tblLocation')
    ? { error: new Error('x'.repeat(900)) }
    : { columns: ['ID'], rows: [{ ID: 1 }] }));
  const { mirror, clients } = setup({ pool });
  await mirror.runOnce();
  const runs = syncRuns(clients[0]);
  assert.equal(runs[1].values[4], false);
  assert.equal(runs[1].values[5].length, 500);
  assert.ok(!texts(clients[0]).includes('create table if not exists shop."locations"'));
  assert.equal(texts(clients[0]).filter((t) => t === 'BEGIN').length, 2);
  assert.ok(!texts(clients[0]).includes('ROLLBACK'));
});

test('time, datetimeoffset, and wide decimal columns fail that entry with the cast that fixes it', async () => {
  const cases = [
    [{ name: 'StartTime', type: 'time' }, 'column "StartTime" is time, which the mirror cannot copy exactly; cast it in the statement: CONVERT(varchar(40), StartTime, 127) AS StartTime'],
    [{ name: 'Stamped At', type: 'datetimeoffset' }, 'column "Stamped At" is datetimeoffset, which the mirror cannot copy exactly; cast it in the statement: CONVERT(varchar(40), [Stamped At], 127) AS [Stamped At]'],
    [{ name: 'Big', type: 'decimal', precision: 18, scale: 4 }, 'column "Big" is decimal(18, 4), more digits than the driver reads exactly (15); cast it: CONVERT(varchar(50), Big) AS Big'],
  ];
  for (const [column, message] of cases) {
    const pool = stubPool(() => ({ columns: ['ID', column], rows: [{ ID: 1, [column.name]: null }] }));
    const { mirror, clients } = setup({ entries: [ENTRIES[0]], pool });
    assert.equal((await mirror.runOnce()).ok, false);
    assert.equal(syncRuns(clients[0])[0].values[5], message);
    assert.ok(!texts(clients[0]).some((t) => t.startsWith('create table')), column.type);
  }
});

test('money and decimals of up to 15 digits copy as they are', async () => {
  const pool = stubPool(() => ({
    columns: [{ name: 'Price', type: 'money' }, { name: 'Qty', type: 'decimal', precision: 15, scale: 2 }],
    rows: [{ Price: 12.5, Qty: 3.25 }],
  }));
  const { mirror, clients } = setup({ entries: [ENTRIES[0]], pool });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.deepEqual(clients[0].queries.find((q) => q.text.startsWith('insert into')).values, [12.5, 3.25]);
});

test('NUL characters are removed from text before it reaches Postgres', async () => {
  const pool = stubPool(() => ({ columns: ['Name'], rows: [{ Name: 'a\u0000b' }] }));
  const { mirror, clients } = setup({ entries: [ENTRIES[0]], pool });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.deepEqual(clients[0].queries.find((q) => q.text.startsWith('insert into')).values, ['ab']);
});

test('a result set with a nameless column fails that entry', async () => {
  const pool = stubPool(() => ({ columns: [''], rows: [{ '': 1 }] }));
  const { mirror, clients } = setup({ entries: [ENTRIES[0]], pool });
  await mirror.runOnce();
  assert.match(syncRuns(clients[0])[0].values[5], /column with no name; name it with AS/);
  assert.ok(!texts(clients[0]).some((t) => t.startsWith('create table')));
});

test('two columns with the same name fail that entry before anything is written', async () => {
  // mssql folds a repeated column name into one array-valued column.
  const pool = stubPool(() => ({ columns: ['ProjectID'], rows: [{ ProjectID: [1860, 12] }] }));
  const { mirror, clients } = setup({ entries: [ENTRIES[0]], pool });
  await mirror.runOnce();
  assert.match(syncRuns(clients[0])[0].values[5], /two columns with the same name/);
  assert.ok(!texts(clients[0]).some((t) => t.startsWith('create table')));
});

test('an overlapping tick is skipped and logged', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { mirror, logs, clients } = setup({
    clientOpts: { onQuery: (text) => (text === 'BEGIN' ? gate : undefined) },
  });
  const first = mirror.runOnce();
  await new Promise((r) => setImmediate(r));
  assert.equal(mirror.status().inFlight, true);
  const second = await mirror.runOnce();
  assert.deepEqual(second, { skipped: true });
  assert.ok(logs.some((l) => /skipped: previous run still in flight/.test(l)));
  release();
  await first;
  assert.equal(clients.length, 1);
  assert.equal(mirror.status().inFlight, false);
});

test('batches of 500 rows: ceil(n/500) INSERTs with matching placeholder counts', async () => {
  const n = 1234;
  const rows = Array.from({ length: n }, (_, i) => ({ ID: i, Name: `r${i}` }));
  const pool = stubPool(() => ({ columns: ['ID', 'Name'], rows }));
  const { mirror, clients } = setup({ entries: [ENTRIES[2]], pool });
  await mirror.runOnce();
  const inserts = clients[0].queries.filter((q) => q.text.startsWith('insert into'));
  assert.equal(inserts.length, Math.ceil(n / 500));
  const sizes = [500, 500, 234];
  for (const [i, ins] of inserts.entries()) {
    const placeholders = ins.text.match(/\$\d+/g);
    assert.equal(placeholders.length, sizes[i] * 2);
    assert.equal(ins.values.length, sizes[i] * 2);
    assert.equal(placeholders.at(-1), `$${sizes[i] * 2}`);
  }
  assert.equal(syncRuns(clients[0])[0].values[3], n);
});

test('very wide tables use smaller batches to stay under the 65,535 parameter limit', () => {
  const columns = Array.from({ length: 200 }, (_, i) => `C${i}`);
  const rows = Array.from({ length: 700 }, () => Object.fromEntries(columns.map((c) => [c, 1])));
  const batches = buildInsertBatches('wide', columns, rows);
  assert.ok(batches[0].text.startsWith('insert into shop."wide" ("C0", '));
  for (const b of batches) assert.ok(b.values.length <= 65535);
  assert.equal(batches.reduce((sum, b) => sum + b.values.length, 0), 700 * 200);
});

test('zero source rows: the copy is emptied and no INSERT is sent', async () => {
  const pool = stubPool(() => ({ columns: ['ID'], rows: [] }));
  const { mirror, clients } = setup({ entries: [ENTRIES[2]], pool });
  await mirror.runOnce();
  assert.deepEqual(texts(clients[0]).slice(0, 5), [
    'create table if not exists shop."contacts"', 'COLUMNS', 'BEGIN', 'DELETE FROM shop."contacts"', 'COMMIT',
  ]);
});

test('a Postgres connect failure marks the run failed and does not throw', async () => {
  const logs = [];
  const mirror = createMirror({
    getPool: async () => sourcePool(),
    pgConnectionString: 'postgresql://u:p@h:5432/db',
    mirror: ENTRIES,
    log: (l) => logs.push(l),
    createPgClient: () => ({ connect: async () => { throw new Error('ECONNREFUSED'); }, end: async () => {} }),
  });
  assert.deepEqual(await mirror.runOnce(), { skipped: false, ok: false });
  assert.equal(mirror.status().lastOk, false);
  assert.ok(logs.some((l) => /run FAILED/.test(l)));
});

test('pgClientConfig verifies the server against the Supabase CA, ignores the URL ssl settings, and sets client-side deadlines', () => {
  const cfg = pgClientConfig(
    'postgresql://shop_mirror:pw@aws-0.pooler.supabase.com:5432/postgres?sslmode=disable&sslrootcert=x.crt&uselibpqcompat=true&ssl=false',
    CA,
  );
  assert.deepEqual(cfg, {
    connectionString: 'postgresql://shop_mirror:pw@aws-0.pooler.supabase.com:5432/postgres',
    ssl: { ca: CA, rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    query_timeout: 120000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
    application_name: 'dws-shop-bridge-mirror',
  });
});

test('refresh_jobs returning ok:false marks the run failed without throwing', async () => {
  const { mirror, logs, clients } = setup({ clientOpts: { refreshResult: { ok: false, error: 'boom' } } });
  const result = await mirror.runOnce();
  assert.equal(result.ok, false);
  assert.equal(syncRuns(clients[0]).length, ENTRIES.length); // entry rows still recorded
  assert.ok(logs.some((l) => /refresh_jobs FAILED/.test(l)));
  const status = mirror.status();
  assert.equal(status.lastOk, false);
  assert.equal(status.refreshJobs.ok, false);
  assert.deepEqual(status.refreshJobs.result, { ok: false, error: 'boom' });
});

test('refresh_jobs throwing replaces an earlier ok in the status', async () => {
  let fail = false;
  const { mirror, logs } = setup({
    clientOpts: { fail: (text) => (fail && /refresh_jobs/.test(text) ? new Error('Query read timeout') : null) },
  });
  assert.equal((await mirror.runOnce()).ok, true);
  assert.equal(mirror.status().refreshJobs.ok, true);
  fail = true;
  assert.equal((await mirror.runOnce()).ok, false);
  const { refreshJobs } = mirror.status();
  assert.equal(refreshJobs.ok, false);
  assert.equal(refreshJobs.result, null);
  assert.equal(refreshJobs.error, 'Query read timeout');
  assert.ok(refreshJobs.finishedAt);
  assert.ok(logs.some((l) => /refresh_jobs FAILED error="Query read timeout"/.test(l)));
});

test('refresh_jobs returning ok:true keeps the run ok and exposes the result', async () => {
  const { mirror, clients } = setup({ clientOpts: { refreshResult: { ok: true, upserted: 2, skipped_trashed: 0, dropped_from_open: [] } } });
  const result = await mirror.runOnce();
  assert.equal(result.ok, true);
  assert.equal(clients[0].ended, true);
  assert.equal(mirror.status().refreshJobs.result.upserted, 2);
});
