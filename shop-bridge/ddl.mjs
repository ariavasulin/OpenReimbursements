// Generate Postgres `create table` SQL for mirrored tables from SQL Server metadata.
import { buildCreateTable, isSafeTableName, quoteIdent } from './types.mjs';

const COLUMNS_SQL = `
select COLUMN_NAME, DATA_TYPE, IS_NULLABLE
from INFORMATION_SCHEMA.COLUMNS
where TABLE_SCHEMA = 'dbo' and TABLE_NAME = @table
order by ORDINAL_POSITION`;

const PK_SQL = `
select k.COLUMN_NAME
from INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
join INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  on k.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA
 and k.CONSTRAINT_NAME = t.CONSTRAINT_NAME
 and k.TABLE_NAME = t.TABLE_NAME
where t.CONSTRAINT_TYPE = 'PRIMARY KEY' and t.TABLE_SCHEMA = 'dbo' and t.TABLE_NAME = @table
order by k.ORDINAL_POSITION`;

/** @returns {Promise<{ table: string, columns: {name, dataType, nullable}[], pkColumns: string[] }>} */
export async function fetchTableMetadata(pool, table) {
  if (!isSafeTableName(table)) {
    const err = new Error(`not a plain table name: ${table}`);
    err.code = 'ETABLENAME';
    throw err;
  }
  const cols = await pool.request().input('table', table).query(COLUMNS_SQL);
  if (!cols.recordset || cols.recordset.length === 0) {
    const err = new Error(`table dbo.${table} not found (or no columns visible to this login)`);
    err.code = 'ETABLENOTFOUND';
    throw err;
  }
  const pk = await pool.request().input('table', table).query(PK_SQL);
  return {
    table,
    columns: cols.recordset.map((r) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: String(r.IS_NULLABLE).toUpperCase() === 'YES',
    })),
    pkColumns: (pk.recordset ?? []).map((r) => r.COLUMN_NAME),
  };
}

/** The SQL for a migration file: one create table (plus the mirror role's grant) per table. */
export async function ddlForTables(pool, tables) {
  const parts = [
    `-- Mirror tables generated from SQL Server metadata on ${new Date().toISOString()}.`,
    '-- Review before applying. Column names keep their SQL Server casing.',
  ];
  for (const table of tables) {
    const meta = await fetchTableMetadata(pool, table);
    parts.push(
      '',
      buildCreateTable(meta.table, meta.columns, meta.pkColumns),
      `grant select, insert, delete on shop.${quoteIdent(meta.table)} to shop_mirror;`,
    );
  }
  return parts.join('\n') + '\n';
}
