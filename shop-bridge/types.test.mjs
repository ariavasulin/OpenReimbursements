import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCreateTableFromRecordset, isIdentifier, pgType, SQL_TO_PG } from './types.mjs';

test('type map', () => {
  const expected = {
    int: 'integer', smallint: 'integer', tinyint: 'integer',
    bigint: 'bigint',
    bit: 'boolean',
    varchar: 'text', nvarchar: 'text', char: 'text', nchar: 'text', text: 'text', ntext: 'text',
    smalldatetime: 'timestamp', datetime: 'timestamp', datetime2: 'timestamp', date: 'timestamp',
    money: 'numeric', smallmoney: 'numeric', decimal: 'numeric', numeric: 'numeric',
    float: 'double precision', real: 'double precision',
  };
  assert.deepEqual({ ...SQL_TO_PG }, expected);
  for (const [sqlType, pg] of Object.entries(expected)) assert.equal(pgType(sqlType), pg);
});

test('pgType is case-insensitive and defaults to text', () => {
  assert.equal(pgType('NVARCHAR'), 'text');
  assert.equal(pgType('DateTime'), 'timestamp');
  assert.equal(pgType('uniqueidentifier'), 'text');
  assert.equal(pgType('varbinary'), 'text');
  assert.equal(pgType(undefined), 'text');
});

test('buildCreateTableFromRecordset: result order, mapped types, all nullable, no primary key', () => {
  // mssql recordset.columns: keyed by name, ordered by `index`, type.declaration is the SQL Server type.
  const columns = {
    Archived: { index: 2, name: 'Archived', type: { declaration: 'bit' } },
    ProjectID: { index: 0, name: 'ProjectID', type: { declaration: 'int' } },
    Project: { index: 1, name: 'Project', type: { declaration: 'varchar' } },
    Completed: { index: 3, name: 'Completed', type: { declaration: 'datetime' } },
    Odd: { index: 4, name: 'Odd', type: {} },
  };
  assert.equal(
    buildCreateTableFromRecordset('projects', columns),
    'create table if not exists shop."projects" (\n' +
      '  "ProjectID" integer,\n' +
      '  "Project" text,\n' +
      '  "Archived" boolean,\n' +
      '  "Completed" timestamp,\n' +
      '  "Odd" text\n' +
      ');',
  );
  assert.equal(
    buildCreateTableFromRecordset('x', { 'a"b': { index: 0, name: 'a"b', type: { declaration: 'int' } } }),
    'create table if not exists shop."x" (\n  "a""b" integer\n);',
  );
});

test('isIdentifier', () => {
  assert.ok(isIdentifier('tblMas90JobMasterOpen'));
  assert.ok(isIdentifier('_x1'));
  assert.ok(!isIdentifier('1tbl'));
  assert.ok(!isIdentifier('tbl"; drop'));
  assert.ok(!isIdentifier('dbo.tblProject'));
  assert.ok(!isIdentifier(''));
});
