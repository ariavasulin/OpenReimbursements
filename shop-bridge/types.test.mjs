import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingColumns, isIdentifier, mirrorTypeProblem, pgType, plainValue, SQL_TO_PG } from './types.mjs';

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

test('pgType defaults to text', () => {
  assert.equal(pgType('uniqueidentifier'), 'text');
  assert.equal(pgType('varbinary'), 'text');
  assert.equal(pgType(undefined), 'text');
});

test('landingColumns: result order, mapped types, names kept as they are', () => {
  // mssql recordset.columns: keyed by name, ordered by `index`, type.declaration is the SQL Server type.
  const columns = {
    Archived: { index: 2, name: 'Archived', type: { declaration: 'bit' } },
    ProjectID: { index: 0, name: 'ProjectID', type: { declaration: 'int' } },
    Project: { index: 1, name: 'Project', type: { declaration: 'varchar' } },
    Completed: { index: 3, name: 'Completed', type: { declaration: 'datetime' } },
    'a"b': { index: 4, name: 'a"b', type: {} },
  };
  assert.deepEqual(landingColumns(columns), [
    { name: 'ProjectID', type: 'integer' },
    { name: 'Project', type: 'text' },
    { name: 'Archived', type: 'boolean' },
    { name: 'Completed', type: 'timestamp' },
    { name: 'a"b', type: 'text' },
  ]);
});

test('isIdentifier', () => {
  assert.ok(isIdentifier('tblMas90JobMasterOpen'));
  assert.ok(isIdentifier('_x1'));
  assert.ok(!isIdentifier('1tbl'));
  assert.ok(!isIdentifier('tbl"; drop'));
  assert.ok(!isIdentifier('dbo.tblProject'));
  assert.ok(!isIdentifier(''));
});

test('plainValue: zone-less wall-clock dates, hex binary, no NUL, everything else unchanged', () => {
  assert.equal(plainValue(new Date('2026-01-02T09:00:00.123Z')), '2026-01-02T09:00:00.123');
  assert.equal(plainValue(Buffer.from([0x00, 0xff])), '00ff');
  assert.equal(plainValue('a\u0000b\u0000'), 'ab');
  for (const v of [null, undefined, 0, 12.5, true, 'plain']) assert.equal(plainValue(v), v);
});

test('mirrorTypeProblem: refuses time, datetimeoffset, and decimals over 15 digits, with the cast to use', () => {
  const col = (name, declaration, extra = {}) => ({ name, type: { declaration }, ...extra });
  assert.equal(
    mirrorTypeProblem(col('T', 'time')),
    'column "T" is time, which the mirror cannot copy exactly; cast it in the statement: CONVERT(varchar(40), T, 127) AS T',
  );
  assert.equal(
    mirrorTypeProblem(col('Odd]Name', 'datetimeoffset')),
    'column "Odd]Name" is datetimeoffset, which the mirror cannot copy exactly; cast it in the statement: CONVERT(varchar(40), [Odd]]Name], 127) AS [Odd]]Name]',
  );
  assert.equal(
    mirrorTypeProblem(col('N', 'numeric', { precision: 19, scale: 0 })),
    'column "N" is numeric(19, 0), more digits than the driver reads exactly (15); cast it: CONVERT(varchar(50), N) AS N',
  );
  for (const ok of [
    col('D', 'decimal', { precision: 15, scale: 2 }), col('M', 'money'), col('S', 'smallmoney'),
    col('W', 'datetime'), col('W2', 'datetime2'), col('V', 'varchar'), col('X', undefined),
  ]) {
    assert.equal(mirrorTypeProblem(ok), null, ok.type.declaration);
  }
});
