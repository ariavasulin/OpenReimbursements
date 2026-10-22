// Test doubles for the mssql pool and pg client. Not shipped to the bridge box.
import { EventEmitter } from 'node:events';

/**
 * mssql column metadata. A column is a name (typed nvarchar) or `{ name, type }`
 * where type is the lowercase SQL Server type name (mssql's `type.declaration`).
 */
function columnsMeta(columns) {
  return Object.fromEntries(columns.map((col, index) => {
    const { name, type = 'nvarchar' } = typeof col === 'string' ? { name: col } : col;
    return [name, { index, name, type: { declaration: type } }];
  }));
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
