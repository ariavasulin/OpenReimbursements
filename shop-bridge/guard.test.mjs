import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReadOnlySql } from './guard.mjs';

const accepts = [
  'select 1',
  'SELECT top 5 * from tblProject',
  'with x as (select 1 as n) select * from x',
  '-- open jobs\nselect ProjectID,\n  Project /* the name */\nfrom tblProject\nwhere Archived = 0',
  "select * from tblProject where Project = 'a -- not a comment'",
  'select [Updated At] = 1', // bracketed identifiers are kept, but this one has no banned word
  '  \n\tSelect 1  ',
  'select ProjectIDinto from tblIntoThings', // banned words only match whole words
  'SELECT ProjectID FROM dbo.tblProject ORDER BY ProjectID OFFSET 0 ROWS FETCH FIRST 10 ROWS ONLY',
  "SELECT ProjectID, CASE WHEN Archived = 1 THEN 'archived' ELSE 'active' END AS State FROM dbo.tblProject",
];

for (const sql of accepts) {
  test(`accepts: ${JSON.stringify(sql).slice(0, 60)}`, () => {
    assert.deepEqual(checkReadOnlySql(sql), { ok: true });
  });
}

const rejects = [
  ['select 1; select 2', /semicolon/],
  ['select 1;', /semicolon/],
  ['insert into t values (1)', /single SELECT/],
  ['update tblProject set Project = 1', /single SELECT/],
  ['delete from tblProject', /single SELECT/],
  ['select 1 insert into t values (1)', /insert/],
  ['select 1 update t set a = 1', /update/],
  ['select 1 delete from t', /delete/],
  ['select * into t from u', /into/],
  ['exec sp_who', /single SELECT/],
  ['select 1 exec sp_who', /exec/],
  ['select * from sys.objects cross apply sp_helptext', /sp_/],
  ['drop table x', /single SELECT/],
  ['select 1 drop table x', /drop/],
  ['select 1 /* ; */ ; drop table x', /semicolon|drop/],
  ['/* select */ update tblProject set Project = 1', /single SELECT/],
  ['-- select\nupdate tblProject set Project = 1', /single SELECT/],
  ["select '/*' ; drop table x --*/'", /semicolon|drop/], // comment marker inside a string cannot hide code
  ['select 1 /* unterminated', /unterminated/],
  ["select 'unterminated", /unterminated/],
  ['select * from openquery(x, y)', /openquery/],
  ["select 1 waitfor delay '00:01'", /waitfor/],
  // T-SQL needs no semicolon between statements, so a second statement is caught by its keyword.
  ['SELECT 1 BEGIN TRAN SELECT * FROM dbo.tblProject WITH (TABLOCKX, HOLDLOCK)', /begin/],
  ['SELECT * FROM dbo.tblProject WITH (TABLOCKX, HOLDLOCK)', /tablockx/],
  ['SELECT * FROM dbo.tblProject WITH (UPDLOCK)', /updlock/],
  ['SELECT 1 SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', /set/],
  ['SELECT 1 USE master', /use/],
  ['SELECT 1 DECLARE @x int', /declare/],
  ['SELECT NEXT VALUE FOR dbo.seq AS n', /next/],
  ['SELECT 1 COMMIT', /commit/],
  ["SELECT 1 IF 1 = 1 PRINT 'x'", /if/],
  ["SELECT 1 RAISERROR('x', 16, 1)", /raiserror/],
  ['SELECT ProjectID FROM dbo.tblProject ORDER BY ProjectID OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', /next/],
  ['', /empty/],
  ['   \n  ', /empty/],
  ['-- only a comment', /empty/],
  [`select '${'a'.repeat(64 * 1024)}'`, /64 KiB/],
];

for (const [sql, reason] of rejects) {
  test(`rejects: ${JSON.stringify(sql).slice(0, 60)}`, () => {
    const result = checkReadOnlySql(sql);
    assert.equal(result.ok, false);
    assert.match(result.reason, reason);
  });
}

test('two SELECTs in a row still pass: the filter is not a parser', () => {
  assert.deepEqual(checkReadOnlySql('SELECT 1 SELECT 2'), { ok: true });
});

test('rejects non-strings', () => {
  assert.equal(checkReadOnlySql(undefined).ok, false);
  assert.equal(checkReadOnlySql(42).ok, false);
});
