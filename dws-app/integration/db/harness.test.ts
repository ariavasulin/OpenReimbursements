import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseIdentity, assertLocalTestTarget } from '../../scripts/test-local-target.mjs';

describe('isolated test target safety', () => {
  it('rejects production and remote connection overrides before opening a connection', () => {
    expect(() => assertLocalTestTarget({ ...process.env, NEXT_PUBLIC_SUPABASE_URL: 'https://qebbmojnqzwwdpkhuyyd.supabase.co' })).toThrow(/non-local/);
    expect(() => assertLocalTestTarget({ ...process.env, DWS_TEST_DATABASE_URL: 'postgresql://postgres:unused@db.example.com:5432/postgres' })).toThrow(/non-local/);
    expect(() => assertLocalTestTarget({ ...process.env, DWS_TEST_PROJECT: 'qebbmojnqzwwdpkhuyyd' })).toThrow(/disposable/);
    expect(process.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  });

  it('requires the actual database marker to match this invocation', async () => {
    const sql = new pg.Client({ connectionString: process.env.DWS_TEST_DATABASE_URL });
    await sql.connect();
    try {
      await expect(assertDatabaseIdentity(sql)).resolves.toBeUndefined();
      const other = process.env.DWS_TEST_PROJECT === 'dws-test-000000000000' ? 'dws-test-111111111111' : 'dws-test-000000000000';
      await expect(assertDatabaseIdentity(sql, { ...process.env, DWS_TEST_PROJECT: other })).rejects.toThrow(/matching disposable/);
    } finally {
      await sql.end();
    }
  });
});
