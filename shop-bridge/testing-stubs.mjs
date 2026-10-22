// Test doubles for the mssql pool and the mirror's Supabase API. Not shipped to the bridge box.
import { EventEmitter } from 'node:events';

/**
 * mssql column metadata. A column is a name (typed nvarchar) or `{ name, type, precision, scale }`
 * where type is the lowercase SQL Server type name (mssql's `type.declaration`).
 */
function columnsMeta(columns) {
  return Object.fromEntries(columns.map((col, index) => {
    const { name, type = 'nvarchar', precision, scale } = typeof col === 'string' ? { name: col } : col;
    return [name, { index, name, type: { declaration: type }, precision, scale }];
  }));
}

const cancelError = () => Object.assign(new Error('Canceled.'), { code: 'ECANCEL' });

/**
 * Mimics an mssql Request in stream mode (the only mode the bridge uses): recordset,
 * row, error, and done events. `{ hang: true }` sends the columns and then no rows
 * until the request is cancelled, like a query still running on the server.
 */
class FakeRequest extends EventEmitter {
  constructor(behavior) {
    super();
    this.behavior = behavior;
    this.inputs = {};
    this.stream = false;
    this.cancelled = false;
    this.whenCancelled = new Promise((resolve) => { this.onCancel = resolve; });
  }

  input(name, value) {
    this.inputs[name] = value;
    return this;
  }

  cancel() {
    this.cancelled = true;
    this.onCancel();
    return true;
  }

  async query(sql) {
    this.sql = sql;
    if (!this.stream) throw new Error('FakeRequest supports stream mode only');
    const outcome = await this.behavior(sql, this);
    if (outcome.error) {
      this.emit('error', outcome.error);
    } else if (outcome.hang) {
      this.emit('recordset', columnsMeta(outcome.columns));
      await this.whenCancelled;
      this.emit('error', cancelError());
    } else {
      this.emit('recordset', columnsMeta(outcome.columns));
      for (const row of outcome.rows) {
        if (this.cancelled) {
          this.emit('error', cancelError());
          break;
        }
        this.emit('row', { ...row });
      }
    }
    this.emit('done', {});
    return {};
  }
}

/**
 * @param {(sql: string, request: FakeRequest) => ({ columns: (string|object)[], rows: object[] } | { columns, hang: true } | { error: Error }) | Promise<...>} behavior
 */
export function stubPool(behavior) {
  const requests = [];
  return {
    requests,
    request() {
      const r = new FakeRequest(behavior);
      requests.push(r);
      return r;
    },
  };
}

/**
 * Stands in for createMirrorApi: records every call as { fn, table, columns, rows, error }.
 * `respond(call)` returns the call's result (default { ok: true, row_count: rows.length },
 * and { ok: false, error } for a recorded failure), or throws to act as a failed request.
 */
export function stubMirrorApi({
  respond = (call) => (call.error ? { ok: false, error: call.error } : { ok: true, row_count: call.rows.length }),
  refresh = () => ({ ok: true, upserted: 0 }),
  onCall = async () => {},
} = {}) {
  const calls = [];
  const record = async (call) => {
    calls.push(call);
    await onCall(call);
    return call.fn === 'refresh' ? refresh(call) : respond(call);
  };
  return {
    calls,
    replace: (table, columns, rows) => record({ fn: 'replace', table, columns, rows }),
    recordFailure: (table, error) => record({ fn: 'recordFailure', table, error }),
    refresh: () => record({ fn: 'refresh' }),
  };
}

export const mssqlError = (code, name = 'RequestError') =>
  Object.assign(new Error(`stub ${code}`), { code, name });
