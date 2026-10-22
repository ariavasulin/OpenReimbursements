// Test doubles for the mssql pool and pg client. Not shipped to the bridge box.
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

const CREATE_RE = /^create table if not exists shop\."((?:[^"]|"")+)" \(/;
const COLUMN_RE = /^ {2}"((?:[^"]|"")+)"/gm;
const unquote = (s) => s.replace(/""/g, '"');

/**
 * Records every pg query; `fail(text, values)` returning an Error makes that query reject.
 * `tables` maps shop table name -> column names already in Postgres; `create table if not
 * exists` adds to it and the information_schema.columns lookup reads from it.
 */
export function stubPgClient({
  fail = () => null,
  onQuery = async () => {},
  refreshResult = { upserted: 0 },
  tables = {},
} = {}) {
  const client = {
    tables,
    queries: [],
    connected: false,
    ended: false,
    async connect() { client.connected = true; },
    async end() { client.ended = true; },
    on() { return client; },
    async query(text, values) {
      client.queries.push({ text, values });
      await onQuery(text, values);
      const err = fail(text, values);
      if (err) throw err;
      if (/refresh_jobs/.test(text)) return { rows: [{ result: refreshResult }] };
      const created = CREATE_RE.exec(text);
      if (created) {
        const table = unquote(created[1]);
        tables[table] ??= [...text.matchAll(COLUMN_RE)].map((m) => unquote(m[1]));
        return { rows: [], rowCount: 0 };
      }
      if (/information_schema\.columns/.test(text)) {
        return { rows: (tables[values[0]] ?? []).map((column_name) => ({ column_name })), rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

export const mssqlError = (code, name = 'RequestError') =>
  Object.assign(new Error(`stub ${code}`), { code, name });
