// Print Postgres `create table` SQL for shop tables, read from the live SQL Server metadata.
//
//   node --env-file=.env scripts/ddl.mjs tblProject tblLocation
//   npm run ddl -- tblPM          (with SHOP_DB_* already in the environment)
//
// With no table names, it uses every table in mirror.config.json.
import { readFile } from 'node:fs/promises';
import { closePool, getPool } from '../db.mjs';
import { ddlForTables } from '../ddl.mjs';

let tables = process.argv.slice(2);
if (tables.length === 0) {
  const config = JSON.parse(await readFile(new URL('../mirror.config.json', import.meta.url), 'utf8'));
  tables = config.tables;
}

try {
  const pool = await getPool();
  process.stdout.write(await ddlForTables(pool, tables));
} catch (err) {
  console.error(`ddl failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
