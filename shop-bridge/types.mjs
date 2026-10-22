// SQL Server -> Postgres type map and landing-table DDL for the mirror.
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
 * @param {string} table  table name in the shop schema, kept as-is (e.g. "projects")
 * @param {{ name: string, dataType: string, nullable: boolean }[]} columns  in ordinal order
 * @param {string[]} [pkColumns]  primary key columns in key order; omit or pass [] for none
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

/** mssql result-set column metadata (`recordset.columns`), as an array in result order. */
export function orderedColumns(recordsetColumns) {
  return Object.values(recordsetColumns ?? {}).sort((a, b) => a.index - b.index);
}

/**
 * The landing table for one mirror entry: every column nullable, no primary key
 * (a query's result set has neither). Types come from mssql's `type.declaration`
 * (lowercase SQL Server type name, e.g. "varchar").
 * @param {string} into  table name in the shop schema
 * @param {object} recordsetColumns  mssql `recordset.columns`: { [name]: { index, name, type } }
 */
export function buildCreateTableFromRecordset(into, recordsetColumns) {
  const columns = orderedColumns(recordsetColumns).map((c) => ({
    name: c.name,
    dataType: c.type?.declaration,
    nullable: true,
  }));
  return buildCreateTable(into, columns);
}

/** Names the mirror and queries.json accept (landing tables, live query names): plain identifiers only. */
export function isSafeTableName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
