import { randomBytes, randomInt } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

// The shop mirror's Supabase side (plans/active/shop-db-bridge/plan.md, Phase 2):
// the shop_mirror role boundary (AC-10), shop.refresh_jobs() (AC-11), and the
// admin's public.shop_sync_status(). Office values below are made up.

// No migration creates the landing tables: the bridge does, logged in as shop_mirror,
// from the columns its queries return. These are the shipped entries' tables, in the
// bridge's type map (all nullable, no primary key).
const landingTables: Record<string, string> = {
  projects: '"ProjectID" integer, "Project" text, "Completed" timestamp, "Archived" boolean, "Location" integer',
  locations: '"LocationID" integer, "LocationName" text, "LocationAddress" text, "LocationCity" text',
  open_jobs: '"JobNo" integer, "JobStatus" text',
  contacts: '"ContactID" integer, "CompanyID" integer, "EmplCode" text, "FirstName" text, "LastName" text, '
    + '"email" text, "Mobile" text, "OfficePhone" text, "CurrentEmp" text, "dbTermDate" timestamp',
};

describe('shop mirror schema, role, and jobs refresh', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  let mirror: pg.Client;
  const created: string[] = [];

  beforeAll(async () => {
    f = await createFixtures();
    // The migration sets no password; the operator does, out of band. Do the same
    // here and log in as the role itself, as the bridge box will.
    const password = randomBytes(24).toString('hex');
    await f.sql.query(`alter role shop_mirror password '${password}'`);
    const url = new URL(process.env.DWS_TEST_DATABASE_URL!);
    url.username = 'shop_mirror';
    url.password = password;
    mirror = new pg.Client({ connectionString: url.toString() });
    await mirror.connect();
    for (const [name, columns] of Object.entries(landingTables)) {
      await mirror.query(`create table if not exists shop."${name}" (${columns})`);
    }
  });
  afterAll(async () => {
    await mirror?.end();
    if (created.length) await f.sql.query('delete from public.jobs where job_number = any($1)', [created]);
    await f?.close();
  });

  const asRole = async (role: string, statement: string) => {
    const client = await f.sql.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      return await client.query(statement);
    } finally { await client.query('rollback'); client.release(); }
  };

  it('lets the tables shop_mirror creates be read by the service role, and grants postgres nothing on them', async () => {
    const owners = await f.sql.query(`select c.relname, c.relowner::regrole::text as owner,
        has_table_privilege('service_role', c.oid, 'select') as service_role,
        exists (select 1 from aclexplode(c.relacl) a where a.grantee = 'postgres'::regrole) as postgres
      from pg_class c where c.relnamespace = 'shop'::regnamespace and c.relname = any($1) order by c.relname`,
      [Object.keys(landingTables)]);
    // postgres is checked against the table's own grants, not membership or superuser.
    // refresh_jobs() runs as its caller, so nothing running as postgres needs these.
    expect(owners.rows).toEqual(Object.keys(landingTables).sort().map(relname =>
      ({ relname, owner: 'shop_mirror', service_role: true, postgres: false })));
    expect((await asRole('service_role', 'select count(*)::int as n from shop.contacts')).rows).toEqual([{ n: 0 }]);
  });

  it('lets shop_mirror write shop tables, call refresh_jobs, and read and upsert public.jobs, and nothing else (AC-10)', async () => {
    await mirror.query('begin');
    try {
      await mirror.query(`insert into shop.projects ("ProjectID", "Project") values (${randomInt(1e8, 2e8)}, 'Role check')`);
      await mirror.query('delete from shop.projects where "Project" = \'Role check\'');
      await mirror.query(`insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok) values ('projects', now(), now(), 0, true)`);
      expect((await mirror.query('select shop.refresh_jobs() as r')).rows[0].r.ok).toBe(true);
      // refresh_jobs() runs as its caller, so shop_mirror itself reads and upserts
      // public.jobs; the policy lets it see every row.
      const number = `shop-role-${randomBytes(6).toString('hex')}`;
      await mirror.query(`insert into public.jobs (job_number, name) values ($1, 'Role check')
        on conflict (job_number) do update set name = excluded.name`, [number]);
      await mirror.query(`update public.jobs set location = 'Here' where job_number = $1`, [number]);
      expect((await mirror.query('select location from public.jobs where job_number = $1', [number])).rows)
        .toEqual([{ location: 'Here' }]);
      expect(Number((await mirror.query('select count(*) from public.jobs where job_number <> $1', [number])).rows[0].count))
        .toBe(Number((await f.sql.query('select count(*) from public.jobs')).rows[0].count));
    } finally { await mirror.query('rollback'); }
    for (const statement of [
      'delete from public.jobs where false',
      'truncate public.jobs',
      'select 1 from public.photos limit 1',
      'select 1 from public.user_profiles limit 1',
      'select 1 from public.receipts limit 1',
      'select 1 from auth.users limit 1',
      'select 1 from auth.sessions limit 1',
      'create table public.shop_mirror_probe (a integer)',
      'delete from shop.sync_runs',
      'drop table shop.sync_runs',
      'select public.shop_sync_status()',
    ]) {
      await expect(mirror.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    const publicGrants = await f.sql.query(`select c.relname,
        array(select p from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
              where has_table_privilege('shop_mirror', c.oid, p)) as privileges
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f')
        and has_table_privilege('shop_mirror', c.oid, 'select, insert, update, delete, truncate, references, trigger')`);
    expect(publicGrants.rows).toEqual([{ relname: 'jobs', privileges: ['select', 'insert', 'update'] }]);
    const authGrants = await f.sql.query(`select
        has_schema_privilege('shop_mirror', 'auth', 'usage, create') as schema,
        exists (select 1 from pg_class c where c.relnamespace = 'auth'::regnamespace
                and has_table_privilege('shop_mirror', c.oid, 'select, insert, update, delete, truncate')) as tables`);
    expect(authGrants.rows).toEqual([{ schema: false, tables: false }]);
    const policies = await f.sql.query(`select tablename, policyname from pg_policies where 'shop_mirror' = any(roles)`);
    expect(policies.rows).toEqual([{ tablename: 'jobs', policyname: 'jobs_shop_mirror' }]);
    const memberships = await f.sql.query(`select roleid::regrole::text from pg_auth_members where member = 'shop_mirror'::regrole`);
    expect(memberships.rows).toEqual([]);
    const role = await f.sql.query(`select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname = 'shop_mirror'`);
    expect(role.rows).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true }]);
  });

  it('keeps the shop schema closed to anon and authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of Object.keys(landingTables)) {
        await expect(asRole(role, `select 1 from shop.${table} limit 1`)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(asRole(role, 'select 1 from shop.sync_runs limit 1')).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(role, 'select shop.refresh_jobs()')).rejects.toMatchObject({ code: '42501' });
    }
  });

  // One fresh block of office numbers per scenario, so repeated runs and other
  // files' jobs never collide with these.
  async function seed() {
    const base = randomInt(10_000, 99_999) * 100;
    const n = (k: number) => base + k;
    const handMade = `P-${base}`;
    created.push(...[1, 2, 3, 4, 5, 6, 7].map(k => String(n(k))), handMade);
    // The mirror replaces whole tables, so each scenario starts from empty copies. The
    // landing tables are shop_mirror's, written as the bridge writes them.
    await mirror.query('delete from shop.projects; delete from shop.open_jobs; delete from shop.locations');
    await mirror.query(`insert into shop.locations ("LocationID", "LocationName", "LocationAddress", "LocationCity") values
      (1, ' Harbor Tower ', '1 Main St', 'Oakland'), (2, null, ' 2 Side St ', 'Berkeley')`);
    await mirror.query(`insert into shop.projects ("ProjectID", "Project", "Location", "Completed", "Archived") values
      ($1, '  Lobby refresh ', 1, null, false),
      ($2, 'Not on the Sage list', 1, null, false),
      ($3, 'Finished job', 1, now(), false),
      ($4, 'Archived job', 1, null, true),
      ($5, 'In the app Trash', 1, null, false),
      ($6, 'Renamed in the office', 2, null, null)`, [n(1), n(2), n(3), n(4), n(5), n(6)]);
    await mirror.query(`insert into shop.open_jobs ("JobNo", "JobStatus") values
      ($1, 'O'), ($2, 'O'), ($3, 'O'), ($4, 'O'), ($5, 'O')`, [n(1), n(3), n(4), n(5), n(6)]);
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
  // Called as the bridge calls it: logged in as shop_mirror.
  const refresh = async () => (await mirror.query('select shop.refresh_jobs() as r')).rows[0].r;
  const runCount = async () => Number((await f.sql.query(`select count(*) from shop.sync_runs where table_name = 'public.jobs'`)).rows[0].count);

  it('refreshes open office jobs and leaves Trash, P- rows, and closed jobs alone (AC-11)', async () => {
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

  it('records a failed refresh instead of losing it', async () => {
    const { n } = await seed();
    const runsBefore = await runCount();
    const before = await jobs([String(n(6))]);
    await mirror.query('begin');
    try {
      // Force a failure inside the upsert, as shop_mirror: the same job number listed
      // open twice makes one insert touch the same public.jobs row twice.
      await mirror.query(`insert into shop.open_jobs ("JobNo", "JobStatus") values ($1, 'O')`, [n(1)]);
      const result = await refresh();
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain('cannot affect row a second time');
      // The upsert's other rows were rolled back with it.
      expect((await mirror.query('select name from public.jobs where job_number = $1', [String(n(6))])).rows)
        .toEqual([{ name: 'Old office name' }]);
      const run = (await mirror.query(`select ok, error, row_count from shop.sync_runs
        where table_name = 'public.jobs' order by id desc limit 1`)).rows[0];
      expect(run).toMatchObject({ ok: false, row_count: null });
      expect(run.error).toContain('cannot affect row a second time');
    } finally { await mirror.query('rollback'); }
    expect(await runCount()).toBe(runsBefore);
    expect(await jobs([String(n(6))])).toEqual(before);
  });

  it('records a failed refresh when a landing table does not exist yet', async () => {
    const runsBefore = await runCount();
    await mirror.query('begin');
    try {
      // As before the bridge's first run: the function exists, the table does not.
      await mirror.query('drop table shop.open_jobs');
      const result = await refresh();
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain('open_jobs');
      const run = (await mirror.query(`select ok, error, row_count from shop.sync_runs
        where table_name = 'public.jobs' order by id desc limit 1`)).rows[0];
      expect(run).toMatchObject({ ok: false, row_count: null });
      expect(run.error).toContain('open_jobs');
    } finally { await mirror.query('rollback'); }
    expect(await runCount()).toBe(runsBefore);
  });

  it('runs a landing-table swap with shop_mirror\'s rights, so it cannot read app tables', async () => {
    // The attack refresh_jobs() would allow if it ran with its owner's rights: shop_mirror
    // swaps a landing table for a view over its own function, which copies an app table
    // into a table shop_mirror can read.
    await seed();
    expect(Number((await f.sql.query('select count(*) from public.user_profiles')).rows[0].count)).toBeGreaterThan(0);
    await mirror.query('begin');
    try {
      await mirror.query('alter table shop.locations rename to locations_real');
      await mirror.query('create table shop.loot (row_data text)');
      await mirror.query(`create function shop.steal() returns setof shop.locations_real
        language plpgsql security invoker as $f$
        begin
          insert into shop.loot select row_to_json(u)::text from public.user_profiles u;
          return query select * from shop.locations_real;
        end $f$`);
      await mirror.query('create view shop.locations as select * from shop.steal()');
      const result = await refresh();
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain('permission denied for table user_profiles');
      expect((await mirror.query('select count(*)::int as n from shop.loot')).rows).toEqual([{ n: 0 }]);
    } finally { await mirror.query('rollback'); }
    const relkind = await f.sql.query(`select relkind from pg_class where oid = 'shop.locations'::regclass`);
    expect(relkind.rows).toEqual([{ relkind: 'r' }]);
  });

  it('reports the newest run per table to the service role only', async () => {
    const table = `test-${randomBytes(6).toString('hex')}`;
    await f.sql.query(`insert into shop.sync_runs (table_name, started_at, finished_at, row_count, ok, error) values
      ($1, now() - interval '20 minutes', now() - interval '20 minutes', 5, false, 'old failure'),
      ($1, now() - interval '5 minutes', now() - interval '5 minutes', 7, true, null)`, [table]);
    const status = await f.admin.rpc('shop_sync_status');
    expect(status.error).toBeNull();
    const mine = (status.data as Array<Record<string, unknown>>).filter(row => row.table === table);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ table, row_count: 7, ok: true, error: null });
    expect(mine[0].age_seconds).toBeGreaterThanOrEqual(299);
    expect(mine[0].age_seconds).toBeLessThan(400);
    expect(Number.isNaN(Date.parse(String(mine[0].finished_at)))).toBe(false);

    expect((await f.anon.rpc('shop_sync_status')).error).not.toBeNull();
    expect((await f.employeeA.client.rpc('shop_sync_status')).error).not.toBeNull();
    await expect(asRole('anon', 'select public.shop_sync_status()')).rejects.toMatchObject({ code: '42501' });
    await f.sql.query('delete from shop.sync_runs where table_name = $1', [table]);
  });
});
