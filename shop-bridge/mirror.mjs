// The mirror: every N minutes, run each `mirror` statement from queries.json on
// the shop's SQL Server and send the result to Supabase, which replaces table
// shop.<into> with it in one transaction, so a reader sees either the old copy or
// the new one, never a half-copied table. Then ask Supabase to refresh public.jobs.
//
// This box has no database login. It calls two functions over Supabase's HTTPS API
// (dws-app/supabase/migrations/20261017100400_shop_mirror_api.sql), with the
// project's public anon key and this box's mirror token:
//   shop_mirror_replace  replace one table's rows (or record why they could not be read)
//   shop_mirror_refresh  run shop.refresh_jobs()
// Supabase checks the token and does the rest as its own owner role; nothing this
// box sends is run as SQL. Every call Supabase accepts, failed copies included, is
// recorded in shop.sync_runs there.
//
// The landing table is created on the first call from the result's columns. After
// that it is never dropped or altered: if the query's columns change, that entry
// fails until someone drops the table in Supabase.
import { runQuery } from './query.mjs';
import { landingColumns, mirrorTypeProblem, orderedColumns, plainRow } from './types.mjs';

export const DEFAULT_MIRROR_MAX_ROWS = 100000;
// One API call, body included. The largest shipped table (contacts) is about 1 MB of JSON.
const API_TIMEOUT_MS = 60000;
const ERROR_MAX_CHARS = 500;

const errorText = (err) => String(err?.message ?? err).slice(0, ERROR_MAX_CHARS);

/**
 * The HTTPS client for the two mirror functions.
 * @param {object} opts
 * @param {string} opts.supabaseUrl  SHOP_MIRROR_SUPABASE_URL, e.g. https://<project-ref>.supabase.co
 * @param {string} opts.apiKey  SHOP_MIRROR_API_KEY: the project's public anon (or publishable) key
 * @param {string} opts.token  SHOP_MIRROR_TOKEN: this box's mirror token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 */
export function createMirrorApi({ supabaseUrl, apiKey, token, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS }) {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/`;
  const headers = { apikey: apiKey, 'content-type': 'application/json', accept: 'application/json' };
  // A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
  if (apiKey.split('.').length === 3) headers.authorization = `Bearer ${apiKey}`;

  async function call(fn, args) {
    let status;
    let text;
    try {
      // The deadline covers the response body too.
      const res = await fetchImpl(base + fn, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_token: token, ...args }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : errorText(err?.cause ?? err);
      throw new Error(`could not reach Supabase (${reason})`);
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // reported below
    }
    if (status === 401 || status === 403) {
      throw new Error(`Supabase refused the call (HTTP ${status}: ${errorText(body?.message ?? text)}); ` +
        'check SHOP_MIRROR_API_KEY, and that SHOP_MIRROR_TOKEN matches the hash in shop.mirror_token');
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Supabase answered HTTP ${status}: ${errorText(body?.message ?? text)}`);
    }
    if (body === null || typeof body !== 'object') throw new Error(`Supabase answered HTTP ${status} without a JSON result`);
    return body;
  }

  return {
    replace: (table, columns, rows) => call('shop_mirror_replace', { p_table: table, p_columns: columns, p_rows: rows }),
    recordFailure: (table, error) => call('shop_mirror_replace', { p_table: table, p_error: error }),
    refresh: () => call('shop_mirror_refresh', {}),
  };
}

/**
 * @param {object} opts
 * @param {() => Promise<import('mssql').ConnectionPool>} opts.getPool
 * @param {ReturnType<typeof createMirrorApi>} opts.api
 * @param {{ into: string, sql: string }[]} opts.mirror  the `mirror` entries from queries.json
 * @param {number} [opts.maxRows=100000]  SHOP_MIRROR_MAX_ROWS: an entry returning more rows fails unwritten
 * @param {number} [opts.intervalMinutes=15]
 * @param {(line: string) => void} [opts.log]
 */
export function createMirror({
  getPool,
  api,
  mirror: entries,
  maxRows = DEFAULT_MIRROR_MAX_ROWS,
  intervalMinutes = 15,
  log = (line) => console.log(line),
}) {
  const say = (msg) => log(`${new Date().toISOString()} mirror ${msg}`);
  const state = { lastRunAt: null, lastOk: null, lastError: null, inFlight: false, tables: {}, refreshJobs: null };
  let timer = null;

  /** Read one entry from SQL Server; a problem here is the entry's error, sent to Supabase as such. */
  async function readEntry(sql) {
    const pool = await getPool();
    const { columns: names, recordsetColumns, rows, truncated } = await runQuery(pool, sql, {}, { maxRows });
    if (truncated) {
      throw new Error(`the query returned more than ${maxRows} rows (SHOP_MIRROR_MAX_ROWS); nothing was written`);
    }
    if (names.length === 0) throw new Error('the query returned no columns');
    if (names.some((n) => !n)) throw new Error('the query returns a column with no name; name it with AS');
    for (const column of orderedColumns(recordsetColumns)) {
      const problem = mirrorTypeProblem(column);
      if (problem) throw new Error(problem);
    }
    // mssql folds two same-named columns into one array-valued column, and its column
    // metadata already lists the name once, so only a row shows it: a result with no
    // rows passes this check (and then the landing table's column check decides).
    if (rows.length > 0 && names.some((n) => Array.isArray(rows[0][n]))) {
      throw new Error('the query returns two columns with the same name; give each its own AS alias');
    }
    return { columns: landingColumns(recordsetColumns), rows: rows.map(plainRow) };
  }

  async function runOnce() {
    if (state.inFlight) {
      say('skipped: previous run still in flight');
      return { skipped: true };
    }
    state.inFlight = true;
    const runStarted = Date.now();
    let allOk = true;
    let runError = null;
    try {
      for (const entry of entries) {
        const table = entry.into;
        const startedAt = Date.now();
        let rowCount = null;
        let error = null;
        let read = null;
        try {
          read = await readEntry(entry.sql);
        } catch (err) {
          error = errorText(err);
        }
        try {
          const result = read ? await api.replace(table, read.columns, read.rows) : await api.recordFailure(table, error);
          if (result.ok === true) rowCount = result.row_count ?? null;
          else error ??= errorText(result.error ?? 'Supabase reported a failure');
        } catch (err) {
          // Not recorded in Supabase: the reason is only here, in the log and /health.
          error ??= errorText(err);
          runError ??= errorText(err);
        }
        const ok = error === null;
        if (!ok) allOk = false;
        const finishedAt = new Date();
        state.tables[table] = { rowCount, ok, finishedAt: finishedAt.toISOString(), error };
        say(`${table} ${ok ? 'ok' : 'FAILED'} rows=${rowCount ?? '-'} ms=${finishedAt - startedAt}${error ? ` error=${JSON.stringify(error)}` : ''}`);
      }

      // shop_mirror_refresh writes its own sync_runs row ('public.jobs'). It refuses to
      // refresh, and says so, when the latest recorded copy of a table it reads failed.
      // A copy that never reached Supabase left no record there, so the refresh would
      // join the previous copy of that table with this run's others: skip it instead.
      let refresh;
      if (runError) {
        refresh = { ok: false, result: null, error: 'skipped: a copy did not reach Supabase this run' };
        say(`refresh_jobs ${refresh.error}`);
      } else {
        try {
          const result = await api.refresh();
          refresh = { ok: result.ok === true, result, error: null };
          say(`refresh_jobs ${refresh.ok ? 'ok' : 'FAILED'} ${JSON.stringify(result)}`);
        } catch (err) {
          refresh = { ok: false, result: null, error: errorText(err) };
          runError = refresh.error;
          say(`refresh_jobs FAILED error=${JSON.stringify(refresh.error)}`);
        }
      }
      if (!refresh.ok) allOk = false;
      state.refreshJobs = { ...refresh, finishedAt: new Date().toISOString() };
    } finally {
      state.lastRunAt = new Date().toISOString();
      state.lastOk = allOk;
      state.lastError = runError;
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
    /** lastError: why the last run could not reach Supabase or was refused there, else null. */
    status() {
      return {
        enabled: true,
        lastRunAt: state.lastRunAt,
        lastOk: state.lastOk,
        lastError: state.lastError,
        inFlight: state.inFlight,
        tables: structuredClone(state.tables),
        refreshJobs: structuredClone(state.refreshJobs),
      };
    },
  };
}
