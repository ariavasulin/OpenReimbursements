// SQL Server -> Postgres type map for the mirror, shared by the DDL generator.
// Anything not listed maps to text.

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

export function pgType(dataType) {
  return SQL_TO_PG[String(dataType ?? '').trim().toLowerCase()] ?? 'text';
}

/** Double-quote an identifier, keeping its case. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * @param {string} table  source table name, kept as-is (e.g. "tblProject")
 * @param {{ name: string, dataType: string, nullable: boolean }[]} columns  in ordinal order
 * @param {string[]} pkColumns  primary key columns in key order; may be empty
 */
export function buildCreateTable(table, columns, pkColumns = []) {
  const lines = columns.map(
    (c) => `  ${quoteIdent(c.name)} ${pgType(c.dataType)}${c.nullable ? '' : ' not null'}`,
  );
  if (pkColumns.length > 0) {
    lines.push(`  primary key (${pkColumns.map(quoteIdent).join(', ')})`);
  }
  return `create table if not exists shop.${quoteIdent(table)} (\n${lines.join(',\n')}\n);`;
}

/** Table names the mirror and DDL generator accept: plain identifiers only. */
export function isSafeTableName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
