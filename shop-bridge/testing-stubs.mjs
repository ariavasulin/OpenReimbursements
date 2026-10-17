// Test doubles for the mssql pool and pg client. Not shipped to the bridge box.
import { EventEmitter } from 'node:events';

function columnsMeta(columns) {
  return Object.fromEntries(columns.map((name, index) => [name, { index, name }]));
}

/** Mimics an mssql Request: promise mode, or stream mode with recordset/row/error/done events. */
class FakeRequest extends EventEmitter {
  constructor(behavior) {
    super();
    this.behavior = behavior;
    this.inputs = {};
    this.stream = false;
    this.cancelled = false;
  }

  input(name, value) {
    this.inputs[name] = value;
    return this;
  }

  cancel() {
    this.cancelled = true;
    return true;
  }

  async query(sql) {
    this.sql = sql;
    const outcome = await this.behavior(sql, this);
    if (!this.stream) {
      if (outcome.error) throw outcome.error;
      const recordset = outcome.rows.map((r) => ({ ...r }));
      recordset.columns = columnsMeta(outcome.columns);
      return { recordset, recordsets: [recordset] };
    }
    if (outcome.error) {
      this.emit('error', outcome.error);
    } else {
      this.emit('recordset', columnsMeta(outcome.columns));
      for (const row of outcome.rows) {
        if (this.cancelled) {
          this.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
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
 * @param {(sql: string, request: FakeRequest) => ({ columns: string[], rows: object[] } | { error: Error }) | Promise<...>} behavior
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

/** Records every pg query; `fail(text, values)` returning an Error makes that query reject. */
export function stubPgClient({ fail = () => null, onQuery = async () => {}, refreshResult = { upserted: 0 } } = {}) {
  const client = {
    queries: [],
    connected: false,
    ended: false,
    async connect() { client.connected = true; },
    async end() { client.ended = true; },
    async query(text, values) {
      client.queries.push({ text, values });
      await onQuery(text, values);
      const err = fail(text, values);
      if (err) throw err;
      if (/refresh_jobs/.test(text)) return { rows: [{ result: refreshResult }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

export const mssqlError = (code, name = 'RequestError') =>
  Object.assign(new Error(`stub ${code}`), { code, name });
