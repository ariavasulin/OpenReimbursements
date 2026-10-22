import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadQueries, validateQueries } from './config.mjs';

const ok = (overrides = {}) => ({
  mirror: [
    { into: 'projects', sql: 'SELECT ProjectID, Project FROM dbo.tblProject' },
    { into: 'contacts', sql: 'SELECT ContactID FROM dbo.tblContact' },
  ],
  live: { project_by_id: 'SELECT Project FROM dbo.tblProject WHERE ProjectID = @id' },
  ...overrides,
});

const errorsOf = (obj) => {
  const result = validateQueries(obj);
  assert.equal(result.ok, false);
  assert.equal(result.queries, null);
  return result.errors;
};

test('the shipped queries.json is valid', () => {
  const result = loadQueries(fileURLToPath(new URL('./queries.json', import.meta.url)));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  // shop.refresh_jobs() reads these three landing tables.
  const intos = result.queries.mirror.map((e) => e.into);
  for (const into of ['projects', 'locations', 'open_jobs']) assert.ok(intos.includes(into), into);
});

test('a valid file passes, and an empty live section is fine', () => {
  const full = validateQueries(ok());
  assert.equal(full.ok, true);
  assert.deepEqual(full.errors, []);
  assert.equal(full.queries.live.project_by_id, 'SELECT Project FROM dbo.tblProject WHERE ProjectID = @id');

  const noLive = validateQueries(ok({ live: {} }));
  assert.equal(noLive.ok, true);
  assert.deepEqual(noLive.queries.live, {});
  assert.equal(validateQueries({ mirror: [], live: {} }).ok, true);
});

test('a statement the guard refuses is an error naming the entry, in either section', () => {
  const errors = errorsOf(ok({
    mirror: [
      { into: 'projects', sql: 'SELECT ProjectID FROM dbo.tblProject' },
      { into: 'contacts', sql: 'DELETE FROM dbo.tblContact' },
    ],
    live: { wipe: 'SELECT 1; DROP TABLE dbo.tblProject' },
  }));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^mirror\[1\] \(into "contacts"\): statement refused by the read-only guard: only a single SELECT/);
  assert.match(errors[1], /^live "wipe": statement refused by the read-only guard: semicolons are not allowed/);
});

test('duplicate into names are refused, case-insensitively', () => {
  const errors = errorsOf(ok({
    mirror: [
      { into: 'projects', sql: 'SELECT 1 AS a' },
      { into: 'Projects', sql: 'SELECT 2 AS a' },
    ],
  }));
  assert.deepEqual(errors, ['mirror[1] (into "Projects"): "into" duplicates mirror[0]; each entry needs its own table']);
});

test('unsafe or reserved names are refused', () => {
  const errors = errorsOf(ok({
    mirror: [
      { into: 'shop.projects', sql: 'SELECT 1 AS a' },
      { into: 'sync_runs', sql: 'SELECT 1 AS a' },
      { into: '1st', sql: 'SELECT 1 AS a' },
      { into: 'Mirror_Token', sql: 'SELECT 1 AS a' },
    ],
    live: { 'bad-name': 'SELECT 1 AS a' },
  }));
  assert.equal(errors.length, 5);
  assert.match(errors[0], /^mirror\[0\] \(into "shop\.projects"\): "into" must be a plain table name/);
  assert.match(errors[1], /^mirror\[1\] \(into "sync_runs"\): shop\.sync_runs is used by the mirror itself/);
  assert.match(errors[2], /^mirror\[2\] \(into "1st"\): "into" must be a plain table name/);
  assert.match(errors[3], /^mirror\[3\] \(into "Mirror_Token"\): shop\.Mirror_Token is used by the mirror itself/);
  assert.match(errors[4], /^live "bad-name": the name must be a plain identifier/);
});

test('shape errors say which entry is wrong', () => {
  assert.deepEqual(errorsOf(null), ['the file must be a JSON object with "mirror" and "live"']);
  assert.deepEqual(errorsOf([]), ['the file must be a JSON object with "mirror" and "live"']);

  const missing = errorsOf({});
  assert.equal(missing.length, 2);
  assert.match(missing[0], /"mirror" must be an array/);
  assert.match(missing[1], /"live" must be an object/);

  const errors = errorsOf({
    tables: ['tblProject'],
    mirror: [
      'SELECT 1',
      { into: 'projects' },
      { into: 'locations', sql: 42 },
      { into: 'jobs', sql: 'SELECT 1 AS a', key: 'JobNo' },
    ],
    live: { a: { sql: 'SELECT 1' } },
  });
  assert.deepEqual(errors, [
    'unknown top-level key "tables" (expected "mirror" and "live")',
    'mirror[0]: must be an object with "into" and "sql"',
    'mirror[1] (into "projects"): "sql" must be a string',
    'mirror[2] (into "locations"): "sql" must be a string',
    'mirror[3] (into "jobs"): unknown key "key" (expected "into" and "sql")',
    'live "a": "sql" must be a string',
  ]);
});

test('loadQueries reports unreadable files and bad JSON without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shop-queries-'));
  const missing = loadQueries(path.join(dir, 'nope.json'));
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /^could not read .*nope\.json: ENOENT/);

  const badJson = path.join(dir, 'bad.json');
  writeFileSync(badJson, '{ "mirror": [ }');
  const bad = loadQueries(badJson);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^could not read .*bad\.json: /);

  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(ok()));
  assert.equal(loadQueries(good).ok, true);
});
