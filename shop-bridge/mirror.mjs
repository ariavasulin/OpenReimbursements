// The mirror: every N minutes, copy each configured shop table into Supabase's
// `shop` schema, replacing the whole table inside one Postgres transaction, so a
// reader sees either the old copy or the new one, never a half-copied table.
import pg from 'pg';
import { isSafeTableName, quoteIdent } from './types.mjs';

export const BATCH_ROWS = 500;
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

/** mssql recordset columns, in source order. */
export function recordsetColumnNames(recordset) {
  const meta = recordset?.columns ?? {};
  return Object.values(meta)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.name);
}

function coerce(value) {
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return value;
}

/** Split rows into INSERT statements of at most BATCH_ROWS rows (fewer for very wide tables). */
export function buildInsertBatches(table, columns, rows) {
  const perStatement = Math.max(1, Math.min(BATCH_ROWS, Math.floor(PG_MAX_PARAMS / columns.length)));
  const head = `insert into shop.${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) values `;
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
 * @param {string[]} opts.tables
 * @param {number} [opts.intervalMinutes=15]
 * @param {(line: string) => void} [opts.log]
 * @param {(connectionString: string) => import('pg').Client} [opts.createPgClient]  for tests
 */
export function createMirror({
  getPool,
  pgConnectionString,
  tables,
  intervalMinutes = 15,
  log = (line) => console.log(line),
  createPgClient = defaultCreatePgClient,
}) {
  const say = (msg) => log(`${new Date().toISOString()} mirror ${msg}`);
  const state = { lastRunAt: null, lastOk: null, inFlight: false, tables: {} };
  let timer = null;

  async function copyTable(client, table) {
    if (!isSafeTableName(table)) throw new Error(`not a plain table name: ${table}`);
    const pool = await getPool();
    const result = await pool.request().query(`SELECT * FROM dbo.${quoteIdent(table)}`);
    const rows = result.recordset ?? [];
    const columns = recordsetColumnNames(result.recordset);
    if (columns.length === 0) throw new Error('source returned no columns');

    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query(`DELETE FROM shop.${quoteIdent(table)}`);
      for (const batch of buildInsertBatches(table, columns, rows)) {
        await client.query(batch.text, batch.values);
      }
      await client.query('COMMIT');
    } catch (err) {
      if (began) {
        await client.query('ROLLBACK').catch((e) => say(`${table} rollback failed: ${e.message}`));
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
      await client.connect();

      for (const table of tables) {
        const startedAt = new Date();
        let rowCount = null;
        let ok = true;
        let error = null;
        try {
          rowCount = await copyTable(client, table);
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
        say(`refresh_jobs ok ${JSON.stringify(res.rows?.[0]?.result ?? null)}`);
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
      say(`started: ${tables.length} tables every ${intervalMinutes} min`);
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
      };
    },
  };
}
