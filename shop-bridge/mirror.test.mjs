import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInsertBatches, createMirror, pgClientConfig } from './mirror.mjs';
import { stubPgClient, stubPool } from './testing-stubs.mjs';

const TABLES = ['tblProject', 'tblLocation', 'tblHardware'];

function sourcePool(rowsByTable = {}) {
  return stubPool((sql) => {
    const table = /dbo\."(\w+)"/.exec(sql)[1];
    const rows = rowsByTable[table] ?? [{ ID: 1, Name: `${table} row`, When: new Date('2026-01-02T03:04:05Z'), Blob: Buffer.from([0xab, 0xcd]) }];
    return { columns: ['ID', 'Name', 'When', 'Blob'], rows };
  });
}

function setup({ tables = TABLES, pool = sourcePool(), clientOpts } = {}) {
  const logs = [];
  const clients = [];
  const mirror = createMirror({
    getPool: async () => pool,
    pgConnectionString: 'postgresql://shop_mirror:pw@pooler.example.com:5432/postgres?sslmode=require',
    tables,
    intervalMinutes: 15,
    log: (l) => logs.push(l),
    createPgClient: () => {
      const c = stubPgClient(clientOpts);
      clients.push(c);
      return c;
    },
  });
  return { mirror, logs, clients, pool };
}

const texts = (client) => client.queries.map((q) => q.text);
const syncRuns = (client) => client.queries.filter((q) => q.text.startsWith('INSERT INTO shop.sync_runs'));

test('all tables succeed: one transaction each, a sync_runs row each, then refresh_jobs', async () => {
  const { mirror, clients, pool } = setup();
  const result = await mirror.runOnce();
  assert.deepEqual(result, { skipped: false, ok: true });
  assert.equal(clients.length, 1);
  const [client] = clients;
  assert.ok(client.connected && client.ended);

  assert.deepEqual(pool.requests.map((r) => r.sql), TABLES.map((t) => `SELECT * FROM dbo."${t}"`));
  const sequence = texts(client).map((t) => t.split(' (')[0]);
  assert.deepEqual(sequence, [
    'BEGIN', 'DELETE FROM shop."tblProject"', 'insert into shop."tblProject"', 'COMMIT', 'INSERT INTO shop.sync_runs',
    'BEGIN', 'DELETE FROM shop."tblLocation"', 'insert into shop."tblLocation"', 'COMMIT', 'INSERT INTO shop.sync_runs',
    'BEGIN', 'DELETE FROM shop."tblHardware"', 'insert into shop."tblHardware"', 'COMMIT', 'INSERT INTO shop.sync_runs',
    'SELECT shop.refresh_jobs() AS result',
  ]);

  const insert = client.queries.find((q) => q.text.startsWith('insert into shop."tblProject"'));
  assert.equal(insert.text, 'insert into shop."tblProject" ("ID", "Name", "When", "Blob") values ($1, $2, $3, $4)');
  assert.ok(insert.values[2] instanceof Date);
  assert.equal(insert.values[3], 'abcd'); // Buffer -> hex

  const runs = syncRuns(client);
  assert.equal(runs.length, TABLES.length);
  for (const [i, run] of runs.entries()) {
    const [table, startedAt, finishedAt, rowCount, ok, error] = run.values;
    assert.equal(table, TABLES[i]);
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
  assert.deepEqual(Object.keys(status.tables), TABLES);
  assert.equal(status.tables.tblProject.rowCount, 1);
  assert.equal(status.tables.tblProject.ok, true);
});

test('one table fails: it rolls back and is recorded, the others commit, refresh_jobs still runs', async () => {
  const { mirror, clients } = setup({
    clientOpts: {
      fail: (text) => (text.startsWith('insert into shop."tblLocation"') ? new Error('column "Gone" does not exist') : null),
    },
  });
  const result = await mirror.runOnce();
  assert.equal(result.ok, false);
  const [client] = clients;
  const sequence = texts(client).map((t) => t.split(' (')[0]);
  assert.deepEqual(sequence, [
    'BEGIN', 'DELETE FROM shop."tblProject"', 'insert into shop."tblProject"', 'COMMIT', 'INSERT INTO shop.sync_runs',
    'BEGIN', 'DELETE FROM shop."tblLocation"', 'insert into shop."tblLocation"', 'ROLLBACK', 'INSERT INTO shop.sync_runs',
    'BEGIN', 'DELETE FROM shop."tblHardware"', 'insert into shop."tblHardware"', 'COMMIT', 'INSERT INTO shop.sync_runs',
    'SELECT shop.refresh_jobs() AS result',
  ]);
  const failed = syncRuns(client)[1].values;
  assert.equal(failed[0], 'tblLocation');
  assert.equal(failed[3], null);
  assert.equal(failed[4], false);
  assert.equal(failed[5], 'column "Gone" does not exist');

  const status = mirror.status();
  assert.equal(status.lastOk, false);
  assert.equal(status.tables.tblLocation.ok, false);
  assert.equal(status.tables.tblHardware.ok, true);
});

test('a source read failure is recorded without opening a transaction; long errors are cut to 500 chars', async () => {
  const pool = stubPool((sql) => (sql.includes('tblLocation')
    ? { error: new Error('x'.repeat(900)) }
    : { columns: ['ID'], rows: [{ ID: 1 }] }));
  const { mirror, clients } = setup({ pool });
  await mirror.runOnce();
  const runs = syncRuns(clients[0]);
  assert.equal(runs[1].values[4], false);
  assert.equal(runs[1].values[5].length, 500);
  assert.equal(texts(clients[0]).filter((t) => t === 'BEGIN').length, 2);
  assert.ok(!texts(clients[0]).includes('ROLLBACK'));
});

test('an unsafe table name fails that table only', async () => {
  const { mirror, clients } = setup({ tables: ['tblProject', 'bad"name'] });
  await mirror.runOnce();
  const runs = syncRuns(clients[0]);
  assert.equal(runs[0].values[4], true);
  assert.equal(runs[1].values[4], false);
  assert.match(runs[1].values[5], /not a plain table name/);
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
  const { mirror, clients } = setup({ tables: ['tblContact'], pool });
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
  const batches = buildInsertBatches('tblWide', columns, rows);
  for (const b of batches) assert.ok(b.values.length <= 65535);
  assert.equal(batches.reduce((sum, b) => sum + b.values.length, 0), 700 * 200);
});

test('zero source rows: the copy is emptied and no INSERT is sent', async () => {
  const pool = stubPool(() => ({ columns: ['ID'], rows: [] }));
  const { mirror, clients } = setup({ tables: ['tblHardware'], pool });
  await mirror.runOnce();
  assert.deepEqual(texts(clients[0]).slice(0, 3), ['BEGIN', 'DELETE FROM shop."tblHardware"', 'COMMIT']);
});

test('a Postgres connect failure marks the run failed and does not throw', async () => {
  const logs = [];
  const mirror = createMirror({
    getPool: async () => sourcePool(),
    pgConnectionString: 'postgresql://u:p@h:5432/db',
    tables: TABLES,
    log: (l) => logs.push(l),
    createPgClient: () => ({ connect: async () => { throw new Error('ECONNREFUSED'); }, end: async () => {} }),
  });
  assert.deepEqual(await mirror.runOnce(), { skipped: false, ok: false });
  assert.equal(mirror.status().lastOk, false);
  assert.ok(logs.some((l) => /run FAILED/.test(l)));
});

test('pgClientConfig drops sslmode from the URL and always uses TLS', () => {
  const cfg = pgClientConfig('postgresql://shop_mirror:pw@aws-0.pooler.supabase.com:5432/postgres?sslmode=require');
  assert.equal(cfg.connectionString, 'postgresql://shop_mirror:pw@aws-0.pooler.supabase.com:5432/postgres');
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
  assert.equal(cfg.statement_timeout, 120000);
});
