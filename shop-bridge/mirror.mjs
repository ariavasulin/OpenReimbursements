// The mirror: every N minutes, run each `mirror` statement from queries.json on
// the shop's SQL Server and replace Supabase table shop.<into> with the result,
// inside one Postgres transaction, so a reader sees either the old copy or the
// new one, never a half-copied table.
//
// The landing table is created on first run from the result's columns. After
// that the service never drops or alters it: if the query's columns change, that
// entry fails until someone drops the table in Supabase.
import pg from 'pg';
import { checkReadOnlySql } from './guard.mjs';
import { buildCreateTableFromRecordset, isIdentifier, orderedColumns, quoteIdent } from './types.mjs';

export const BATCH_ROWS = 500;
export const DEFAULT_MIRROR_MAX_ROWS = 100000;
const PG_MAX_PARAMS = 65535;
const ERROR_MAX_CHARS = 500;

/**
 * pg reads `sslmode` from the URL and, in current versions, treats `require` as
 * full certificate verification, which fails against the Supabase pooler's
 * certificate chain. So drop the URL's ssl settings and always require TLS
 * ourselves: encrypted, without verifying the chain (`rejectUnauthorized: false`).
 * That is acceptable here: the target host is fixed in the URL and the
 * password still authenticates us; it is what `sslmode=require` means in libpq.
 */
export function pgClientConfig(connectionString) {
  const url = new URL(connectionString);
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
    application_name: 'dws-shop-bridge-mirror',
  };
}

function defaultCreatePgClient(connectionString) {
  return new pg.Client(pgClientConfig(connectionString));
}

const LANDING_COLUMNS_SQL =
  "select column_name from information_schema.columns where table_schema = 'shop' and table_name = $1 order by ordinal_position";

const listNames = (names) => `[${names.join(', ')}]`;

function coerce(value) {
  // Dates carry SQL Server's wall-clock time in their UTC fields (db.mjs). Writing them as
  // zone-less ISO text keeps that wall-clock value in a Postgres `timestamp`, whatever the
  // bridge computer's time zone; pg would otherwise convert a Date to local time.
  if (value instanceof Date) return value.toISOString().slice(0, -1);
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return value;
}

/**
 * Split rows into INSERT statements of at most BATCH_ROWS rows (fewer for very wide tables).
 * @param {string} into  table name in the shop schema
 */
export function buildInsertBatches(into, columns, rows) {
  const perStatement = Math.max(1, Math.min(BATCH_ROWS, Math.floor(PG_MAX_PARAMS / columns.length)));
  const head = `insert into shop.${quoteIdent(into)} (${columns.map(quoteIdent).join(', ')}) values `;
  const batches = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const slice = rows.slice(start, start + perStatement);
    const values = [];
    const tuples = slice.map((row, r) => {
      const ph = columns.map((col, c) => {
        values.push(coerce(row[col]));
        return `$${r * columns.length + c + 1}`;
      });
      return `(${ph.join(', ')})`;
    });
    batches.push({ text: head + tuples.join(', '), values });
  }
  return batches;
}

/**
 * @param {object} opts
 * @param {() => Promise<import('mssql').ConnectionPool>} opts.getPool
 * @param {string} opts.pgConnectionString  SHOP_MIRROR_DATABASE_URL (role shop_mirror, session pooler)
 * @param {{ into: string, sql: string }[]} opts.mirror  the `mirror` entries from queries.json
 * @param {number} [opts.maxRows=100000]  SHOP_MIRROR_MAX_ROWS: an entry returning more rows fails unwritten
 * @param {number} [opts.intervalMinutes=15]
 * @param {(line: string) => void} [opts.log]
 * @param {(connectionString: string) => import('pg').Client} [opts.createPgClient]  for tests
 */
export function createMirror({
  getPool,
  pgConnectionString,
  mirror: entries,
  maxRows = DEFAULT_MIRROR_MAX_ROWS,
  intervalMinutes = 15,
  log = (line) => console.log(line),
  createPgClient = defaultCreatePgClient,
}) {
  const say = (msg) => log(`${new Date().toISOString()} mirror ${msg}`);
  const state = { lastRunAt: null, lastOk: null, inFlight: false, tables: {}, refreshJobs: null };
  let timer = null;

  /** Create shop.<into> if missing, then require its columns to match the result's exactly. */
  async function ensureLandingTable(client, into, recordsetColumns, names) {
    await client.query(buildCreateTableFromRecordset(into, recordsetColumns));
    const res = await client.query(LANDING_COLUMNS_SQL, [into]);
    const existing = (res.rows ?? []).map((r) => r.column_name);
    if (existing.length === 0) {
      throw new Error(`landing table shop.${into} is not visible to this login after create table; check the shop_mirror role's grants on schema shop`);
    }
    const same = existing.length === names.length && existing.every((name, i) => name === names[i]);
    if (!same) {
      throw new Error(
        `landing table shop.${into} has columns ${listNames(existing)} but the query returns ${listNames(names)}; ` +
          `drop table shop.${into} in Supabase and the next run recreates it`,
      );
    }
  }

  async function copyEntry(client, { into, sql }) {
    if (!isIdentifier(into)) throw new Error(`not a plain table name: ${into}`);
    const verdict = checkReadOnlySql(sql);
    if (!verdict.ok) throw new Error(`statement refused by the read-only guard: ${verdict.reason}`);

    const pool = await getPool();
    const result = await pool.request().query(sql);
    const rows = result.recordset ?? [];
    const recordsetColumns = result.recordset?.columns ?? {};
    const names = orderedColumns(recordsetColumns).map((c) => c.name);
    if (names.length === 0) throw new Error('the query returned no columns');
    if (names.some((n) => !n)) throw new Error('the query returns a column with no name; name it with AS');
    // mssql folds two same-named columns into one array-valued column.
    if (rows.length > 0 && names.some((n) => Array.isArray(rows[0][n]))) {
      throw new Error('the query returns two columns with the same name; give each its own AS alias');
    }
    if (rows.length > maxRows) {
      throw new Error(
        `the query returned ${rows.length} rows, over the limit of ${maxRows} (SHOP_MIRROR_MAX_ROWS); nothing was written`,
      );
    }

    await ensureLandingTable(client, into, recordsetColumns, names);

    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query(`DELETE FROM shop.${quoteIdent(into)}`);
      for (const batch of buildInsertBatches(into, names, rows)) {
        await client.query(batch.text, batch.values);
      }
      await client.query('COMMIT');
    } catch (err) {
      if (began) {
        await client.query('ROLLBACK').catch((e) => say(`${into} rollback failed: ${e.message}`));
      }
      throw err;
    }
    return rows.length;
  }

  async function recordRun(client, run) {
    try {
      await client.query(
        'INSERT INTO shop.sync_runs (table_name, started_at, finished_at, row_count, ok, error) VALUES ($1, $2, $3, $4, $5, $6)',
        [run.table, run.startedAt, run.finishedAt, run.rowCount, run.ok, run.error],
      );
    } catch (err) {
      say(`${run.table} could not write sync_runs: ${err.message}`);
    }
  }

  async function runOnce() {
    if (state.inFlight) {
      say('skipped: previous run still in flight');
      return { skipped: true };
    }
    state.inFlight = true;
    const runStarted = Date.now();
    let allOk = true;
    let client = null;
    try {
      client = createPgClient(pgConnectionString);
      // A connection dropped mid-run emits 'error' on the client; unhandled, that would end the process.
      client.on('error', (err) => say(`postgres connection error: ${err.message}`));
      await client.connect();

      for (const entry of entries) {
        const table = entry.into;
        const startedAt = new Date();
        let rowCount = null;
        let ok = true;
        let error = null;
        try {
          rowCount = await copyEntry(client, entry);
        } catch (err) {
          ok = false;
          allOk = false;
          error = String(err?.message ?? err).slice(0, ERROR_MAX_CHARS);
        }
        const finishedAt = new Date();
        state.tables[table] = { rowCount, ok, finishedAt: finishedAt.toISOString(), error };
        say(`${table} ${ok ? 'ok' : 'FAILED'} rows=${rowCount ?? '-'} ms=${finishedAt - startedAt}${error ? ` error=${JSON.stringify(error)}` : ''}`);
        await recordRun(client, { table, startedAt, finishedAt, rowCount, ok, error });
      }

      // shop.refresh_jobs() writes its own sync_runs row ('public.jobs'), so none is written here.
      try {
        const res = await client.query('SELECT shop.refresh_jobs() AS result');
        const result = res.rows?.[0]?.result ?? null;
        // The function records its own failure row and returns { ok: false, error } rather
        // than raising, so that row survives; it never throws for a data problem.
        if (result && result.ok === false) {
          allOk = false;
          say(`refresh_jobs FAILED ${JSON.stringify(result)}`);
        } else {
          say(`refresh_jobs ok ${JSON.stringify(result)}`);
        }
        state.refreshJobs = { ok: !(result && result.ok === false), finishedAt: new Date().toISOString(), result };
      } catch (err) {
        allOk = false;
        say(`refresh_jobs FAILED error=${JSON.stringify(err.message)}`);
      }
    } catch (err) {
      allOk = false;
      say(`run FAILED error=${JSON.stringify(err?.message ?? String(err))}`);
    } finally {
      if (client) await client.end().catch(() => {});
      state.lastRunAt = new Date().toISOString();
      state.lastOk = allOk;
      state.inFlight = false;
      say(`run done ok=${allOk} ms=${Date.now() - runStarted}`);
    }
    return { skipped: false, ok: allOk };
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      say(`started: ${entries.length} queries every ${intervalMinutes} min, at most ${maxRows} rows each`);
      runOnce();
      timer = setInterval(runOnce, intervalMinutes * 60_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return {
        enabled: true,
        lastRunAt: state.lastRunAt,
        lastOk: state.lastOk,
        inFlight: state.inFlight,
        tables: structuredClone(state.tables),
        refreshJobs: structuredClone(state.refreshJobs),
      };
    },
  };
}
