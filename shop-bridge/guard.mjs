// The statement guard for queries.json: a pure function, no database access.
// Every statement is checked when the file loads and again right before it runs.
//
// It is a second line of defence. The first is the shop database login itself,
// which is read-only (db_datareader + db_denydatawriter), so even SQL that slips
// past this check cannot write. The guard is deliberately conservative: when in
// doubt it rejects, and a statement can take values through `@params` instead of
// inlining them (a banned word inside a string literal is still rejected).

export const MAX_SQL_BYTES = 64 * 1024;

// Whole words, case-insensitive. `into` catches `select ... into newtable`.
// dbcc, kill, deny and reconfigure are additions beyond the plan's list.
const BANNED_WORDS = [
  'insert', 'update', 'delete', 'merge', 'into', 'exec', 'execute', 'drop', 'alter',
  'create', 'truncate', 'grant', 'revoke', 'deny', 'backup', 'restore', 'openrowset',
  'opendatasource', 'openquery', 'waitfor', 'shutdown', 'dbcc', 'kill', 'reconfigure',
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
export function stripComments(sql) {
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
  if (typeof sql !== 'string') return { ok: false, reason: 'sql must be a string' };
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
    return { ok: false, reason: 'sql is longer than 64 KiB' };
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
