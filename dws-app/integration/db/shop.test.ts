import { createHash, randomBytes, randomInt } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';
// The bridge's own mirror and HTTPS client (no dependencies of their own), for the end-to-end case.
import { createMirror, createMirrorApi } from '../../../shop-bridge/mirror.mjs';
import { stubPool } from '../../../shop-bridge/testing-stubs.mjs';

// The shop mirror's Supabase side: the two functions the bridge box calls over the
// HTTPS API (public.shop_mirror_replace and public.shop_mirror_refresh), the tables
// they create, shop.refresh_jobs(), and the admin's public.shop_sync_status(). Every
// call below goes through PostgREST with the anon key, as the box's calls do. Office
// values are made up.

// The shipped entries' columns, in the bridge's type map (shop-bridge/types.mjs).
const landing = {
  projects: [['ProjectID', 'integer'], ['Project', 'text'], ['Completed', 'timestamp'], ['Archived', 'boolean'], ['Location', 'integer']],
  locations: [['LocationID', 'integer'], ['LocationName', 'text'], ['LocationAddress', 'text'], ['LocationCity', 'text']],
  open_jobs: [['JobNo', 'integer'], ['JobStatus', 'text']],
  contacts: [['ContactID', 'integer'], ['CompanyID', 'integer'], ['EmplCode', 'text'], ['FirstName', 'text'], ['LastName', 'text'],
    ['email', 'text'], ['Mobile', 'text'], ['OfficePhone', 'text'], ['CurrentEmp', 'text'], ['dbTermDate', 'timestamp']],
} as const;
type Table = keyof typeof landing;
const columns = (table: Table) => landing[table].map(([name, type]) => ({ name, type }));

describe('shop mirror API, tables, and jobs refresh', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const token = randomBytes(32).toString('hex');
  const created: string[] = [];

  beforeAll(async () => {
    f = await createFixtures();
    // What the operator runs once, with the hash install/setup.ps1 prints.
    await f.sql.query(`insert into shop.mirror_token (token_sha256) values ($1)
      on conflict (id) do update set token_sha256 = excluded.token_sha256, set_at = now()`,
      [createHash('sha256').update(token, 'utf8').digest()]);
    for (const table of Object.keys(landing) as Table[]) {
      expect(await replace(table, [])).toEqual({ ok: true, row_count: 0 });
    }
  });
  afterAll(async () => {
    if (created.length) await f?.sql.query('delete from public.jobs where job_number = any($1)', [created]);
    await f?.sql.query('delete from shop.mirror_token');
    await f?.close();
  });

  // As the bridge calls them: the anon key plus the mirror token.
  const replace = async (table: string, rows: object[], cols: object[] = columns(table as Table), error?: string) => {
    const res = await f.anon.rpc('shop_mirror_replace', { p_token: token, p_table: table, p_columns: cols, p_rows: rows, ...(error ? { p_error: error } : {}) });
    expect(res.error).toBeNull();
    return res.data;
  };
  const refresh = async () => {
    const res = await f.anon.rpc('shop_mirror_refresh', { p_token: token });
    expect(res.error).toBeNull();
    return res.data;
  };

  // Runs fn in a transaction that is always rolled back.
  const rolledBack = async <T>(fn: (client: pg.PoolClient) => Promise<T>) => {
    const client = await f.sql.connect();
    try {
      await client.query('begin');
      return await fn(client);
    } finally { await client.query('rollback'); client.release(); }
  };
  const asRole = (role: string, statement: string) => rolledBack(async client => {
    await client.query(`set local role ${role}`);
    return client.query(statement);
  });

  it('refuses a missing or wrong token, and any caller other than anon', async () => {
    for (const p_token of [null, '', 'x'.repeat(64), token.toUpperCase()]) {
      const replaced = await f.anon.rpc('shop_mirror_replace', { p_token, p_table: 'projects', p_columns: columns('projects'), p_rows: [] });
      expect(replaced.error?.code, String(p_token)).toBe('42501');
      expect((await f.anon.rpc('shop_mirror_refresh', { p_token })).error?.code).toBe('42501');
    }
    // The signed-in apps and the service role do not call these.
    for (const client of [f.employeeA.client, f.admin]) {
      expect((await client.rpc('shop_mirror_refresh', { p_token: token })).error).not.toBeNull();
    }
    // Without the stored hash, the right token is refused too: deleting the row revokes the box.
    await rolledBack(async client => {
      await client.query('delete from shop.mirror_token');
      await client.query('set local role anon');
      await expect(client.query('select public.shop_mirror_refresh($1)', [token])).rejects.toMatchObject({ code: '42501' });
    });
    // Nothing else in shop is callable: the token check and refresh_jobs are postgres's.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(asRole(role, 'select shop.refresh_jobs()')).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(role, `select shop.require_mirror_token('${token}')`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('creates landing tables owned by postgres, readable by the service role only', async () => {
    const tables = await f.sql.query(`select c.relname, c.relkind, c.relowner::regrole::text as owner,
        has_table_privilege('service_role', c.oid, 'select') as service_role,
        has_table_privilege('anon', c.oid, 'select') as anon,
        has_table_privilege('authenticated', c.oid, 'select') as authenticated
      from pg_class c where c.relnamespace = 'shop'::regnamespace and c.relname = any($1) order by c.relname`,
      [Object.keys(landing)]);
    expect(tables.rows).toEqual(Object.keys(landing).sort().map(relname =>
      ({ relname, relkind: 'r', owner: 'postgres', service_role: true, anon: false, authenticated: false })));
    const types = await f.sql.query(`select a.attname, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
      where a.attrelid = 'shop.projects'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`);
    expect(types.rows).toEqual(landing.projects.map(([attname, type]) =>
      ({ attname, type: type === 'timestamp' ? 'timestamp without time zone' : type })));
    for (const role of ['anon', 'authenticated']) {
      for (const table of [...Object.keys(landing), 'sync_runs', 'mirror_token']) {
        await expect(asRole(role, `select 1 from shop.${table} limit 1`)).rejects.toMatchObject({ code: '42501' });
      }
    }
    expect((await asRole('service_role', 'select count(*)::int as n from shop.contacts')).rows).toEqual([{ n: 0 }]);
  });

  it('treats everything the box sends as data: names are quoted, types come from a fixed list', async () => {
    const table = `probe_${randomBytes(4).toString('hex')}`;
    try {
      const odd = 'a"); drop table shop.sync_runs; --';
      expect(await replace(table, [{ [odd]: 'still just a value' }], [{ name: odd, type: 'text' }])).toEqual({ ok: true, row_count: 1 });
      expect((await f.sql.query(`select * from shop.${table}`)).rows).toEqual([{ [odd]: 'still just a value' }]);
      expect((await f.sql.query(`select to_regclass('shop.sync_runs') is not null as kept`)).rows).toEqual([{ kept: true }]);
      for (const type of ['shop.odd', 'text) ; drop table shop.sync_runs; --', 'regclass', 'jsonb']) {
        const res = await replace(`${table}_t`, [], [{ name: 'v', type }]);
        expect(res.ok, type).toBe(false);
        expect(res.error, type).toContain('not one the mirror allows');
      }
      for (const p_table of ['sync_runs', 'mirror_token', 'Sync_Runs', 'a"b', 'x; drop table shop.sync_runs', '', 'x'.repeat(64)]) {
        const res = await f.anon.rpc('shop_mirror_replace', { p_token: token, p_table, p_columns: [{ name: 'v', type: 'text' }], p_rows: [] });
        expect(res.error?.code, p_table).toBe('22023');
      }
      // Whatever arrived, shop holds only plain tables (and their indexes and
      // sequences) and functions, all owned by postgres: no view, trigger, policy,
      // or type the box could have made run as a reader.
      const objects = await f.sql.query(`
        select 'relation' as kind, relname as name, relkind::text as detail, relowner::regrole::text as owner
          from pg_class where relnamespace = 'shop'::regnamespace and relkind not in ('r', 'i', 'S')
        union all select 'not postgres', relname, relkind::text, relowner::regrole::text
          from pg_class where relnamespace = 'shop'::regnamespace and relowner <> 'postgres'::regrole
        union all select 'function', proname, '', proowner::regrole::text
          from pg_proc where pronamespace = 'shop'::regnamespace and proowner <> 'postgres'::regrole
        union all select 'type', typname, typtype::text, typowner::regrole::text
          from pg_type where typnamespace = 'shop'::regnamespace and typtype <> 'c' and typcategory <> 'A'
        union all select 'trigger', tgname, tgrelid::regclass::text, ''
          from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'shop'::regnamespace)
        union all select 'policy', polname, polrelid::regclass::text, ''
          from pg_policy where polrelid in (select oid from pg_class where relnamespace = 'shop'::regnamespace)`);
      expect(objects.rows).toEqual([]);
    } finally {
      await f.sql.query(`drop table if exists shop.${table}; drop table if exists shop.${table}_t`);
      await f.sql.query('delete from shop.sync_runs where table_name like $1', [`${table}%`]);
    }
  });

  it('replaces a table in one go, keeps it on a failed copy, and records every call', async () => {
    const table = `probe_${randomBytes(4).toString('hex')}`;
    const cols = [{ name: 'Id', type: 'integer' }, { name: 'When', type: 'timestamp' }, { name: 'Amount', type: 'numeric' }];
    const runs = async () => (await f.sql.query(`select row_count, ok, error from shop.sync_runs where table_name = $1 order by id`, [table])).rows;
    try {
      expect(await replace(table, [{ Id: 1, When: '2026-01-02T09:00:00.000', Amount: 12.5 }, { Id: 2 }], cols)).toEqual({ ok: true, row_count: 2 });
      expect(await replace(table, [{ Id: 3, When: null, Amount: 1 }], cols)).toEqual({ ok: true, row_count: 1 });
      const rows = async () => (await f.sql.query(`select "Id", "When"::text as "When", "Amount"::text as "Amount" from shop.${table}`)).rows;
      expect(await rows()).toEqual([{ Id: 3, When: null, Amount: '1' }]);
      // A value of the wrong type fails the whole copy, and the last good copy stays.
      const bad = await replace(table, [{ Id: 4 }, { Id: 'not a number' }], cols);
      expect(bad.ok).toBe(false);
      expect(await rows()).toEqual([{ Id: 3, When: null, Amount: '1' }]);
      // A query whose columns changed fails until someone drops the table.
      const changed = await replace(table, [], [{ name: 'Id', type: 'integer' }]);
      expect(changed).toMatchObject({ ok: false });
      expect(changed.error).toContain(`drop table shop.${table}`);
      // The box could not read the office table: recorded, the copy left alone.
      expect(await replace(table, [], cols, 'SQL Server: timeout')).toEqual({ ok: false, error: 'SQL Server: timeout' });
      expect(await rows()).toHaveLength(1);
      const recorded = await runs();
      expect(recorded.map(r => r.ok)).toEqual([true, true, false, false, false]);
      expect(recorded.slice(0, 2).map(r => r.row_count)).toEqual([2, 1]);
      expect(recorded[4]).toEqual({ row_count: null, ok: false, error: 'SQL Server: timeout' });
    } finally {
      await f.sql.query(`drop table if exists shop.${table}`);
      await f.sql.query('delete from shop.sync_runs where table_name = $1', [table]);
    }
  });

  it('keeps the four admin functions from anon and authenticated (20261022120000)', async () => {
    const grants = await f.sql.query(`select p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by p.proname`,
      [['get_auth_users_for_admin', 'get_auth_users_count', 'get_admin_receipt_status_counts', 'get_admin_receipts_with_phone']]);
    expect(grants.rows).toEqual(['get_admin_receipt_status_counts', 'get_admin_receipts_with_phone', 'get_auth_users_count', 'get_auth_users_for_admin']
      .map(proname => ({ proname, anon: false, authenticated: false, service_role: true })));
  });

  // One fresh block of office numbers per scenario, so repeated runs and other
  // files' jobs never collide with these. The copies are sent as the bridge sends them.
  async function seed() {
    const base = randomInt(10_000, 99_999) * 100;
    const n = (k: number) => base + k;
    const handMade = `P-${base}`;
    created.push(...[1, 2, 3, 4, 5, 6, 7].map(k => String(n(k))), handMade);
    expect((await replace('locations', [
      { LocationID: 1, LocationName: ' Harbor Tower ', LocationAddress: '1 Main St', LocationCity: 'Oakland' },
      { LocationID: 2, LocationName: null, LocationAddress: ' 2 Side St ', LocationCity: 'Berkeley' },
    ])).ok).toBe(true);
    expect((await replace('projects', [
      { ProjectID: n(1), Project: '  Lobby refresh ', Location: 1, Completed: null, Archived: false },
      { ProjectID: n(2), Project: 'Not on the Sage list', Location: 1, Completed: null, Archived: false },
      { ProjectID: n(3), Project: 'Finished job', Location: 1, Completed: '2026-01-02T09:00:00.000', Archived: false },
      { ProjectID: n(4), Project: 'Archived job', Location: 1, Completed: null, Archived: true },
      { ProjectID: n(5), Project: 'In the app Trash', Location: 1, Completed: null, Archived: false },
      { ProjectID: n(6), Project: 'Renamed in the office', Location: 2, Completed: null, Archived: null },
    ])).ok).toBe(true);
    expect((await replace('open_jobs', [n(1), n(3), n(4), n(5), n(6)].map(JobNo => ({ JobNo, JobStatus: 'O' })))).ok).toBe(true);
    await f.sql.query(`insert into public.jobs (job_number, name, location, is_active, synced_at, deleted_at) values
      ($1, 'Trashed', null, false, now() - interval '1 day', now()),
      ($2, 'Old office name', '17', true, now() - interval '1 day', null),
      ($3, 'Left the open list', null, true, now() - interval '1 day', null),
      ($4, 'Hand-made', 'Somewhere', true, null, null)`, [String(n(5)), String(n(6)), String(n(7)), handMade]);
    return { n, handMade };
  }
  const jobs = async (numbers: string[]) => (await f.sql.query(
    `select job_number, name, location, is_active, synced_at is not null as synced, deleted_at is not null as trashed
       from public.jobs where job_number = any($1) order by job_number`, [numbers])).rows;
  const runCount = async () => Number((await f.sql.query(`select count(*) from shop.sync_runs where table_name = 'public.jobs'`)).rows[0].count);

  it('refreshes open office jobs and leaves Trash, P- rows, and closed jobs alone', async () => {
    const { n, handMade } = await seed();
    const all = [1, 2, 3, 4, 5, 6, 7].map(k => String(n(k)));
    const before = await jobs([String(n(5)), handMade]);
    const runsBefore = await runCount();

    const result = await refresh();
    expect(result).toMatchObject({ ok: true, upserted: 2, skipped_trashed: 1 });
    expect(result.dropped_from_open).toContain(String(n(7)));
    expect(result.dropped_from_open).not.toContain(String(n(1)));
    expect(result.dropped_from_open).not.toContain(handMade);

    const rows = await jobs([...all, handMade]);
    const byNumber = Object.fromEntries(rows.map(row => [row.job_number, row]));
    expect(byNumber[n(1)]).toEqual({ job_number: String(n(1)), name: 'Lobby refresh', location: 'Harbor Tower', is_active: true, synced: true, trashed: false });
    for (const k of [2, 3, 4]) expect(byNumber[n(k)]).toBeUndefined();
    expect(byNumber[n(6)]).toEqual({ job_number: String(n(6)), name: 'Renamed in the office', location: '2 Side St, Berkeley', is_active: true, synced: true, trashed: false });
    expect(byNumber[n(7)]).toMatchObject({ name: 'Left the open list', is_active: true });
    expect(await jobs([String(n(5)), handMade])).toEqual(before);

    expect(await runCount()).toBe(runsBefore + 1);
    const run = (await f.sql.query(`select row_count, ok, error, detail from shop.sync_runs
      where table_name = 'public.jobs' order by id desc limit 1`)).rows[0];
    expect(run).toEqual({ row_count: 2, ok: true, error: null, detail: result });
  });

  it('gives the same state when run twice, with a run row each time', async () => {
    const { n, handMade } = await seed();
    const all = [...[1, 2, 3, 4, 5, 6, 7].map(k => String(n(k))), handMade];
    const runsBefore = await runCount();
    const first = await refresh();
    const afterFirst = await jobs(all);
    const second = await refresh();
    expect(await jobs(all)).toEqual(afterFirst);
    expect(second).toEqual(first);
    expect(await runCount()).toBe(runsBefore + 2);
  });

  it('does not refresh when the latest copy of a table it reads failed, but a contacts failure does not stop it', async () => {
    const { n } = await seed();
    const before = await jobs([String(n(1)), String(n(6))]);
    for (const table of ['open_jobs', 'locations', 'projects'] as const) {
      expect((await replace(table, [], columns(table), 'SQL Server: timeout')).ok).toBe(false);
      expect(await refresh(), table).toEqual({ ok: false, error: `not refreshed: the latest copy of shop.${table} did not succeed` });
      expect(await jobs([String(n(1)), String(n(6))])).toEqual(before);
      await seed();
    }
    expect((await replace('contacts', [], columns('contacts'), 'SQL Server: timeout')).ok).toBe(false);
    expect((await refresh()).ok).toBe(true);
    expect((await replace('contacts', [])).ok).toBe(true);
  });

  it('records a failed refresh instead of losing it', async () => {
    const { n } = await seed();
    const runsBefore = await runCount();
    const before = await jobs([String(n(6))]);
    await rolledBack(async client => {
      // An office column renamed without updating refresh_jobs().
      await client.query('alter table shop.locations rename column "LocationCity" to "City"');
      const result = (await client.query('select shop.refresh_jobs() as r')).rows[0].r;
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain('LocationCity');
      expect((await client.query('select name from public.jobs where job_number = $1', [String(n(6))])).rows)
        .toEqual([{ name: 'Old office name' }]);
      const run = (await client.query(`select ok, error, row_count from shop.sync_runs
        where table_name = 'public.jobs' order by id desc limit 1`)).rows[0];
      expect(run).toMatchObject({ ok: false, row_count: null });
      expect(run.error).toContain('LocationCity');
    });
    expect(await runCount()).toBe(runsBefore);
    expect(await jobs([String(n(6))])).toEqual(before);
  });

  it('counts a job number listed twice in the office data once', async () => {
    const { n } = await seed();
    expect((await replace('open_jobs', [n(1), n(3), n(4), n(5), n(6), n(1), n(6)]
      .map((JobNo, i) => ({ JobNo, JobStatus: i === 6 ? ' o ' : 'O' })))).ok).toBe(true);
    expect(await refresh()).toMatchObject({ ok: true, upserted: 2, skipped_trashed: 1 });
  });

  it('records a failed refresh when a landing table does not exist yet', async () => {
    const runsBefore = await runCount();
    await rolledBack(async client => {
      // As before the bridge's first run: the function exists, the table does not.
      await client.query('drop table shop.open_jobs');
      const result = (await client.query('select shop.refresh_jobs() as r')).rows[0].r;
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain('open_jobs');
    });
    expect(await runCount()).toBe(runsBefore);
  });

  it('reports the newest run and the last good run per table to the service role only', async () => {
    const table = `test-${randomBytes(6).toString('hex')}`;
    await f.sql.query(`insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok, error) values
      ($1, now() - interval '20 minutes', now() - interval '20 minutes', 5, true, null),
      ($1, now() - interval '5 minutes', now() - interval '5 minutes', null, false, 'new failure')`, [table]);
    const status = await f.admin.rpc('shop_sync_status');
    expect(status.error).toBeNull();
    const mine = (status.data as Array<Record<string, unknown>>).filter(row => row.table === table);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ table, row_count: null, ok: false, error: 'new failure' });
    expect(mine[0].age_seconds).toBeGreaterThanOrEqual(299);
    expect(mine[0].age_seconds).toBeLessThan(400);
    expect(Number.isNaN(Date.parse(String(mine[0].finished_at)))).toBe(false);
    const lastOk = Date.now() - Date.parse(String(mine[0].last_ok_at));
    expect(lastOk).toBeGreaterThanOrEqual(19 * 60_000);
    expect(lastOk).toBeLessThan(25 * 60_000);

    expect((await f.anon.rpc('shop_sync_status')).error).not.toBeNull();
    expect((await f.employeeA.client.rpc('shop_sync_status')).error).not.toBeNull();
    await expect(asRole('anon', 'select public.shop_sync_status()')).rejects.toMatchObject({ code: '42501' });
    await f.sql.query('delete from shop.sync_runs where table_name = $1', [table]);
  });

  it('takes a whole run from the bridge\'s own mirror code, and names a refused token', async () => {
    const number = randomInt(10_000, 99_999) * 100 + 99;
    created.push(String(number));
    // SQL Server-shaped results, as mssql reports them, for the four shipped entries.
    const results: Record<string, { columns: object[]; rows: object[] }> = {
      projects: { columns: [{ name: 'ProjectID', type: 'int' }, { name: 'Project', type: 'varchar' }, { name: 'Completed', type: 'datetime' },
        { name: 'Archived', type: 'bit' }, { name: 'Location', type: 'smallint' }],
      rows: [{ ProjectID: number, Project: 'From the bridge', Completed: null, Archived: false, Location: 1 }] },
      locations: { columns: [{ name: 'LocationID', type: 'smallint' }, { name: 'LocationName', type: 'varchar' },
        { name: 'LocationAddress', type: 'varchar' }, { name: 'LocationCity', type: 'varchar' }],
      rows: [{ LocationID: 1, LocationName: 'Yard', LocationAddress: null, LocationCity: null }] },
      open_jobs: { columns: [{ name: 'JobNo', type: 'int' }, { name: 'JobStatus', type: 'varchar' }], rows: [{ JobNo: number, JobStatus: 'O' }] },
      contacts: { columns: landing.contacts.map(([name, type]) => ({ name, type: type === 'integer' ? 'int' : type === 'timestamp' ? 'datetime' : 'nvarchar' })),
        rows: [{ ContactID: 1, CompanyID: 1, EmplCode: '1234567', FirstName: 'A', LastName: 'B', email: null, Mobile: null, OfficePhone: null,
          CurrentEmp: '1', dbTermDate: new Date('2026-01-02T09:00:00Z') }] },
    };
    const pool = stubPool((sql: string) => results[/FROM (\w+)/.exec(sql)![1]]);
    const run = (mirrorToken: string) => createMirror({
      getPool: async () => pool,
      api: createMirrorApi({ supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!, apiKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, token: mirrorToken }),
      mirror: Object.keys(results).map(into => ({ into, sql: `SELECT * FROM ${into}` })),
      log: () => {},
    });
    const mirror = run(token);
    expect(await mirror.runOnce()).toEqual({ skipped: false, ok: true });
    expect((mirror.status().refreshJobs as { result: unknown } | null)?.result).toMatchObject({ ok: true, upserted: 1 });
    expect(await jobs([String(number)])).toEqual([{ job_number: String(number), name: 'From the bridge', location: 'Yard', is_active: true, synced: true, trashed: false }]);
    expect((await f.sql.query(`select "dbTermDate"::text as t from shop.contacts`)).rows).toEqual([{ t: '2026-01-02 09:00:00' }]);

    const refused = run('b'.repeat(64));
    expect(await refused.runOnce()).toEqual({ skipped: false, ok: false });
    expect(refused.status().lastError).toMatch(/Supabase refused the call \(HTTP 401: shop mirror token refused\)/);
  });
});
