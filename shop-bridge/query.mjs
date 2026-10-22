// The one way this program runs a statement on SQL Server: streamed, stopped
// after a row cap, and cancelled at a wall-clock deadline.
import { orderedColumns } from './types.mjs';

export const QUERY_TIMEOUT_MS = 30_000;

export const timeoutMessage = (ms) => `The query ran longer than ${ms / 1000} seconds and was cancelled.`;

/**
 * Stream the query and stop after maxRows + 1 rows, so a huge result never sits
 * in memory: the extra row proves truncation, then the request is cancelled.
 * Only the first result set is kept.
 *
 * The deadline is our own timer, not the driver's requestTimeout: tedious stops
 * that timer at the first packet from the server, so a query that keeps
 * trickling rows would otherwise run forever.
 *
 * mssql emits 'done' after every outcome (including 'error' and cancel).
 * @returns {Promise<{ columns: string[], recordsetColumns: object, rows: object[], truncated: boolean }>}
 *   rows hold the driver's values (Dates, Buffers); recordsetColumns is the raw
 *   mssql column metadata ({ [name]: { index, name, type, precision, scale, ... } }).
 */
export function runQuery(pool, sql, params, { maxRows, timeoutMs = QUERY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const request = pool.request();
    request.stream = true;
    for (const [name, value] of Object.entries(params)) request.input(name, value);

    let recordsetColumns = null;
    let recordsets = 0;
    const rows = [];
    let truncated = false;
    let error = null;

    const deadline = setTimeout(() => {
      error ??= Object.assign(
        new Error(timeoutMessage(timeoutMs)),
        { code: 'ETIMEOUT' },
      );
      request.cancel();
    }, timeoutMs);

    request.on('recordset', (meta) => {
      recordsets += 1;
      if (recordsets === 1) recordsetColumns = meta;
    });
    request.on('row', (row) => {
      if (truncated || recordsets > 1) return;
      if (rows.length < maxRows) {
        rows.push(row);
      } else {
        truncated = true;
        request.cancel();
      }
    });
    request.on('error', (err) => {
      if (truncated && err?.code === 'ECANCEL') return; // our own cancel at the row cap
      error ??= err;
    });
    request.on('done', () => {
      clearTimeout(deadline);
      if (error) reject(error);
      else {
        const columns = orderedColumns(recordsetColumns).map((c) => c.name);
        resolve({ columns, recordsetColumns: recordsetColumns ?? {}, rows, truncated });
      }
    });
    // In stream mode the outcome arrives through the events above; mssql resolves
    // this promise even on error, and the catch only keeps a rejection quiet.
    request.query(sql).catch(() => {});
  });
}
