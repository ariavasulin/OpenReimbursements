// SQL Server values and types, as the bridge hands them on: the one value
// converter (plainValue) used for both live results and the mirror, and the
// SQL Server -> Postgres type map for the mirror's landing tables. Anything not in
// the map lands as text. Supabase's shop_mirror_replace accepts exactly the
// Postgres types this map produces
// (dws-app/supabase/migrations/20261017100400_shop_mirror_api.sql).
//
// Precision, as the driver (mssql/tedious) reads values:
//   - datetime values keep millisecond precision; datetime2 beyond that is truncated.
//   - money and smallmoney are read as a JavaScript number, exact to 15 significant
//     digits: any amount under 100 billion, to its 4 decimal places.
//   - decimal and numeric are read the same way, so the mirror refuses one declared
//     with more than 15 digits of precision (mirrorTypeProblem below).
//   - time and datetimeoffset have no faithful copy here, so the mirror refuses them.

export const SQL_TO_PG = Object.freeze({
  int: 'integer',
  smallint: 'integer',
  tinyint: 'integer',
  bigint: 'bigint',
  bit: 'boolean',
  varchar: 'text',
  nvarchar: 'text',
  char: 'text',
  nchar: 'text',
  text: 'text',
  ntext: 'text',
  smalldatetime: 'timestamp',
  datetime: 'timestamp',
  datetime2: 'timestamp',
  date: 'timestamp',
  money: 'numeric',
  smallmoney: 'numeric',
  decimal: 'numeric',
  numeric: 'numeric',
  float: 'double precision',
  real: 'double precision',
});

// Significant digits a JavaScript number holds exactly.
const EXACT_DIGITS = 15;

/**
 * One SQL Server value, as JSON-safe and Postgres-safe as it gets:
 *   Date   -> zone-less ISO text, e.g. "2026-01-02T09:00:00.000". With the driver's
 *             default (useUTC), a 9:00 shop timestamp arrives as a Date whose UTC
 *             fields read 09:00, so its ISO text minus the trailing "Z" is the shop's
 *             wall-clock time whatever the bridge computer's time zone. Written to a
 *             Postgres `timestamp`, it keeps that wall-clock value (pg would otherwise
 *             convert a Date to the computer's local time).
 *   Buffer -> hex text.
 *   string -> without NUL characters, which Postgres text rejects.
 *   anything else (number, boolean, null) unchanged.
 */
export function plainValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, -1);
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  return value;
}

/** One result row with every value through plainValue, as both live results and the mirror send it. */
export const plainRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plainValue(value)]));

/** Bracket-quote a column name for a T-SQL suggestion, unless it is a plain identifier. */
const sqlName = (name) => (isIdentifier(name) ? name : `[${String(name).replace(/]/g, ']]')}]`);

/**
 * Why the mirror cannot copy this result column as is, with the cast that fixes it,
 * or null when it can.
 * @param {{ name: string, type?: { declaration?: string }, precision?: number }} column  mssql column metadata
 */
export function mirrorTypeProblem(column) {
  const type = String(column.type?.declaration ?? '').toLowerCase();
  const col = sqlName(column.name);
  if (type === 'time' || type === 'datetimeoffset') {
    return `column "${column.name}" is ${type}, which the mirror cannot copy exactly; ` +
      `cast it in the statement: CONVERT(varchar(40), ${col}, 127) AS ${col}`;
  }
  if ((type === 'decimal' || type === 'numeric') && column.precision > EXACT_DIGITS) {
    return `column "${column.name}" is ${type}(${column.precision}, ${column.scale ?? 0}), more digits than the driver ` +
      `reads exactly (${EXACT_DIGITS}); cast it: CONVERT(varchar(50), ${col}) AS ${col}`;
  }
  return null;
}

export function pgType(dataType) {
  return SQL_TO_PG[String(dataType ?? '').trim().toLowerCase()] ?? 'text';
}

/** mssql result-set column metadata (`recordset.columns`), as an array in result order. */
export function orderedColumns(recordsetColumns) {
  return Object.values(recordsetColumns ?? {}).sort((a, b) => a.index - b.index);
}

/**
 * The landing table's columns for one mirror entry, as shop_mirror_replace takes
 * them: [{ name, type }] in result order. Types come from mssql's `type.declaration`
 * (lowercase SQL Server type name, e.g. "varchar").
 * @param {object} recordsetColumns  mssql `recordset.columns`: { [name]: { index, name, type } }
 */
export function landingColumns(recordsetColumns) {
  return orderedColumns(recordsetColumns).map((c) => ({ name: c.name, type: pgType(c.type?.declaration) }));
}

/** Plain identifiers only: landing table names, live query names, and query parameter names. */
export function isIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
