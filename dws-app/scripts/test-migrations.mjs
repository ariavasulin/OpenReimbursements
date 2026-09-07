import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertDatabaseIdentity } from './test-local-target.mjs';

export const migrationDirectory = resolve(import.meta.dirname, '../supabase/migrations');
const concurrentFiles = new Set([
  '20260822120000_add_receipts_indexes.sql',
  '20260822120100_add_photos_indexes.sql',
  '20260823120300_drop_redundant_receipts_indexes.sql',
]);

export async function assertValidIndexes(sql) {
  const { rows } = await sql.query('select indexrelid::regclass::text as name from pg_index where not indisvalid');
  if (rows.length) throw new Error(`Invalid indexes: ${rows.map(row => row.name).join(', ')}`);
}

export async function replayMigrations(sql, { after = '', through = '\uffff' } = {}) {
  await assertDatabaseIdentity(sql);
  const files = (await readdir(migrationDirectory)).filter(name => /^\d{14}_.+\.sql$/.test(name) && name > after && name <= through).sort();
  for (const name of files) {
    const source = await readFile(resolve(migrationDirectory, name), 'utf8');
    if (concurrentFiles.has(name)) {
      // README specifies these files contain only index statements and line comments.
      const statements = source.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
      if (statements.some(s => !/^(create|drop)\s+index\s+concurrently\b/i.test(s))) throw new Error(`Unexpected concurrent migration syntax: ${name}`);
      for (const statement of statements) {
        await sql.query(statement);
        await assertValidIndexes(sql);
      }
    } else {
      if (/\b(?:create|drop)\s+index\s+concurrently\b/i.test(source.replace(/^\s*--.*$/gm, ''))) {
        throw new Error(`Add concurrent migration ${name} to the explicit statement-by-statement list`);
      }
      await sql.query('begin');
      try { await sql.query(source); await sql.query('commit'); }
      catch (error) { await sql.query('rollback'); throw new Error(`Migration ${name} failed`, { cause: error }); }
    }
    console.log(`Applied ${name}`);
  }
  // The captured baseline changes session defaults. Never let them leak into tests.
  await sql.query('reset all');
  await assertValidIndexes(sql);
  await sql.query("notify pgrst, 'reload schema'");
  return files;
}
