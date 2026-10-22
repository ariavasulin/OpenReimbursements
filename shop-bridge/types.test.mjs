import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCreateTable, buildCreateTableFromRecordset, isSafeTableName, pgType, SQL_TO_PG } from './types.mjs';

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

test('buildCreateTable with a primary key and nullable columns', () => {
  const sql = buildCreateTable(
    'tblProject',
    [
      { name: 'ProjectID', dataType: 'int', nullable: false },
      { name: 'Project', dataType: 'nvarchar', nullable: true },
      { name: 'Archived', dataType: 'bit', nullable: false },
      { name: 'Completed', dataType: 'smalldatetime', nullable: true },
      { name: 'Contract Amount', dataType: 'money', nullable: true },
    ],
    ['ProjectID'],
  );
  assert.equal(
    sql,
    'create table if not exists shop."tblProject" (\n' +
      '  "ProjectID" integer not null,\n' +
      '  "Project" text,\n' +
      '  "Archived" boolean not null,\n' +
      '  "Completed" timestamp,\n' +
      '  "Contract Amount" numeric,\n' +
      '  primary key ("ProjectID")\n' +
      ');',
  );
});

test('buildCreateTable without a primary key, composite keys, and quoting', () => {
  assert.equal(
    buildCreateTable('tblX', [{ name: 'a"b', dataType: 'int', nullable: true }], []),
    'create table if not exists shop."tblX" (\n  "a""b" integer\n);',
  );
  assert.match(
    buildCreateTable('tblY', [
      { name: 'A', dataType: 'int', nullable: false },
      { name: 'B', dataType: 'int', nullable: false },
    ], ['A', 'B']),
    /primary key \("A", "B"\)\n\);$/,
  );
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
    buildCreateTable('x', [{ name: 'a', dataType: 'int', nullable: true }]),
    'create table if not exists shop."x" (\n  "a" integer\n);',
  );
});

test('isSafeTableName', () => {
  assert.ok(isSafeTableName('tblMas90JobMasterOpen'));
  assert.ok(isSafeTableName('_x1'));
  assert.ok(!isSafeTableName('1tbl'));
  assert.ok(!isSafeTableName('tbl"; drop'));
  assert.ok(!isSafeTableName('dbo.tblProject'));
  assert.ok(!isSafeTableName(''));
});
