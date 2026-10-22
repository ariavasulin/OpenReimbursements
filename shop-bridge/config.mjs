// queries.json: the only SQL this program runs against the shop database.
//
//   mirror: [{ into, sql }]  each sql runs every mirror interval; its whole result
//                            replaces the Postgres table shop.<into>.
//   live:   { name: sql }    each one is callable as POST /query/<name>.
//
// Every statement must pass the read-only guard, and every name must be a plain
// identifier. The service refuses to start if anything here is wrong.
import { readFileSync } from 'node:fs';
import { checkReadOnlySql } from './guard.mjs';
import { isSafeTableName } from './types.mjs';

// Tables in the shop schema the mirror itself depends on; an entry landing there would wipe them.
export const RESERVED_INTO = Object.freeze(['sync_runs']);

const TOP_KEYS = ['mirror', 'live'];
const ENTRY_KEYS = ['into', 'sql'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkSql(where, sql, errors) {
  if (typeof sql !== 'string') {
    errors.push(`${where}: "sql" must be a string`);
    return;
  }
  const verdict = checkReadOnlySql(sql);
  if (!verdict.ok) errors.push(`${where}: statement refused by the read-only guard: ${verdict.reason}`);
}

/**
 * Pure validation of the parsed queries.json.
 * @returns {{ ok: boolean, errors: string[], queries: { mirror: { into: string, sql: string }[], live: Record<string, string> } | null }}
 */
export function validateQueries(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['the file must be a JSON object with "mirror" and "live"'], queries: null };
  }
  for (const key of Object.keys(obj)) {
    if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level key "${key}" (expected "mirror" and "live")`);
  }

  if (!Array.isArray(obj.mirror)) {
    errors.push('"mirror" must be an array of { "into", "sql" } entries (it may be empty)');
  } else {
    const seen = new Map();
    obj.mirror.forEach((entry, i) => {
      const label = isPlainObject(entry) && typeof entry.into === 'string' ? `mirror[${i}] (into "${entry.into}")` : `mirror[${i}]`;
      if (!isPlainObject(entry)) {
        errors.push(`${label}: must be an object with "into" and "sql"`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!ENTRY_KEYS.includes(key)) errors.push(`${label}: unknown key "${key}" (expected "into" and "sql")`);
      }
      if (!isSafeTableName(entry.into)) {
        errors.push(`${label}: "into" must be a plain table name (letters, digits, underscore; not starting with a digit)`);
      } else {
        const lower = entry.into.toLowerCase();
        if (RESERVED_INTO.includes(lower)) {
          errors.push(`${label}: shop.${entry.into} is used by the mirror itself; pick another name`);
        } else if (seen.has(lower)) {
          errors.push(`${label}: "into" duplicates mirror[${seen.get(lower)}]; each entry needs its own table`);
        } else {
          seen.set(lower, i);
        }
      }
      checkSql(label, entry.sql, errors);
    });
  }

  if (!isPlainObject(obj.live)) {
    errors.push('"live" must be an object of name to SQL statement (it may be empty)');
  } else {
    for (const [name, sql] of Object.entries(obj.live)) {
      const label = `live "${name}"`;
      if (!isSafeTableName(name)) {
        errors.push(`${label}: the name must be a plain identifier (letters, digits, underscore; not starting with a digit)`);
      }
      checkSql(label, sql, errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors, queries: null };
  return {
    ok: true,
    errors: [],
    queries: {
      mirror: obj.mirror.map(({ into, sql }) => ({ into, sql })),
      live: { ...obj.live },
    },
  };
}

/** Read and validate a queries file. Never throws; read and JSON errors come back in `errors`. */
export function loadQueries(filePath) {
  let obj;
  try {
    obj = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`could not read ${filePath}: ${err.message}`], queries: null };
  }
  return validateQueries(obj);
}
