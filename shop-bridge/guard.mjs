// The statement filter for queries.json: a pure function, no database access.
//
// This is a conservative keyword filter, not a SQL parser. After comments are
// removed, a statement passes only if it starts with SELECT or WITH, contains no
// `;`, and contains none of the words listed below anywhere, including inside
// string literals and [bracketed] names (so a column named [Open] cannot be
// named in a statement). Values belong in `@params`, not in the SQL text.
//
// T-SQL needs no `;` between statements, so the word list is what keeps a second
// statement out: writes, transactions, session settings (SET, USE), variables,
// cursors, control flow, and lock hints. It cannot catch everything: two SELECTs
// in a row (`SELECT 1 SELECT 2`) still pass, and the bridge ignores the second
// result set. The real limits are elsewhere: the shop database login is
// read-only (db_datareader + db_denydatawriter), so SQL that slips past this
// filter still cannot write, and the mirror copies a result only if its columns
// match the landing table.

const MAX_SQL_BYTES = 64 * 1024;

// Whole words, case-insensitive. `into` catches `select ... into newtable`;
// `next` catches `NEXT VALUE FOR` (a sequence write) and so also rules out
// `FETCH NEXT`: write `OFFSET ... ROWS FETCH FIRST n ROWS ONLY` instead.
// `fetch` and `end` stay allowed for that and for `CASE ... END`.
const BANNED_WORDS = [
  // Writes and schema changes.
  'insert', 'update', 'delete', 'merge', 'into', 'exec', 'execute', 'drop', 'alter',
  'create', 'truncate', 'grant', 'revoke', 'deny', 'backup', 'restore', 'dbcc', 'kill',
  'reconfigure', 'shutdown', 'next',
  // Reaching other servers or files.
  'openrowset', 'opendatasource', 'openquery',
  // Transactions, session settings, variables, cursors, Service Broker.
  'begin', 'commit', 'rollback', 'save', 'set', 'use', 'declare', 'open', 'close',
  'deallocate', 'receive', 'send', 'conversation',
  // Control flow.
  'if', 'while', 'goto', 'return', 'throw', 'raiserror', 'print', 'waitfor',
  // Lock and isolation hints that would block the shop's own users.
  'tablockx', 'xlock', 'updlock', 'holdlock', 'serializable', 'repeatableread',
];
// Prefixes: any word starting with these (system and extended stored procedures).
const BANNED_PREFIXES = ['sp_', 'xp_'];

const BANNED_RE = new RegExp(
  `\\b(?:${BANNED_WORDS.join('|')})\\b|\\b(?:${BANNED_PREFIXES.join('|')})`,
  'i',
);

/**
 * Remove `--` line comments and `/* *\/` block comments (nested, as SQL Server
 * nests them), while leaving string literals and quoted identifiers intact, so
 * a comment marker inside a string cannot hide code from the checks below.
 * Returns { text } or { error }.
 */
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      out += ' ';
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return { error: 'unterminated block comment' };
      out += ' ';
      continue;
    }
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '[' ? ']' : null;
    if (close) {
      // Copy the literal or quoted identifier as-is; a doubled closing char is an escape.
      let j = i + 1;
      for (;;) {
        if (j >= n) return { error: 'unterminated string or quoted identifier' };
        if (sql[j] === close) {
          if (sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out };
}

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function checkReadOnlySql(sql) {
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
    return { ok: false, reason: `sql is longer than ${MAX_SQL_BYTES / 1024} KiB` };
  }
  const stripped = stripComments(sql);
  if (stripped.error) return { ok: false, reason: stripped.error };
  const text = stripped.text.trim();
  if (text === '') return { ok: false, reason: 'sql is empty' };
  if (!/^(?:select|with)\b/i.test(text)) {
    return { ok: false, reason: 'only a single SELECT or WITH statement is allowed' };
  }
  if (text.includes(';')) return { ok: false, reason: 'semicolons are not allowed' };
  const banned = text.match(BANNED_RE);
  if (banned) return { ok: false, reason: `keyword not allowed: ${banned[0].toLowerCase()}` };
  return { ok: true };
}
