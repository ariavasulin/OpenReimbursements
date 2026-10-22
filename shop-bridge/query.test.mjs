import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runQuery } from './query.mjs';
import { mssqlError, stubPool } from './testing-stubs.mjs';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ ID: i + 1 }));
const columns = [{ name: 'ID', type: 'int' }];

test('returns the rows, column names, and raw column metadata, binding params', async () => {
  const pool = stubPool(() => ({ columns, rows: rows(2) }));
  const result = await runQuery(pool, 'SELECT ID FROM t WHERE x = @x', { x: 1 }, { maxRows: 10 });
  assert.deepEqual(result.columns, ['ID']);
  assert.deepEqual(result.rows, rows(2));
  assert.equal(result.truncated, false);
  assert.equal(result.recordsetColumns.ID.type.declaration, 'int');
  assert.deepEqual(pool.requests[0].inputs, { x: 1 });
});

test('stops at maxRows: keeps maxRows rows, cancels, and reports truncation', async () => {
  const pool = stubPool(() => ({ columns, rows: rows(10) }));
  const result = await runQuery(pool, 'SELECT ID FROM t', {}, { maxRows: 3 });
  assert.deepEqual(result.rows, rows(3));
  assert.equal(result.truncated, true);
  assert.equal(pool.requests[0].cancelled, true);
});

test('a query that keeps running is cancelled at the deadline with ETIMEOUT', async () => {
  const pool = stubPool(() => ({ columns, hang: true }));
  const started = Date.now();
  await assert.rejects(runQuery(pool, 'SELECT ID FROM t', {}, { maxRows: 10, timeoutMs: 50 }), (err) => {
    assert.equal(err.code, 'ETIMEOUT');
    assert.equal(err.message, 'The query ran longer than 0.05 seconds and was cancelled.');
    return true;
  });
  assert.ok(Date.now() - started >= 45);
  assert.equal(pool.requests[0].cancelled, true);
});

test('a driver error rejects with that error', async () => {
  const pool = stubPool(() => ({ error: mssqlError('EREQUEST') }));
  await assert.rejects(runQuery(pool, 'SELECT 1 AS a', {}, { maxRows: 1 }), { code: 'EREQUEST' });
});
