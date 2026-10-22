import { describe, expect, it } from 'vitest';
import { mirrorWarning } from './mirror-warning';

const now = Date.parse('2026-10-22T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe('mirrorWarning', () => {
  it('says nothing when the mirror has never run', () => {
    expect(mirrorWarning([], now)).toBeNull();
  });

  it('says nothing while every table had a good copy within the hour', () => {
    expect(mirrorWarning([{ table: 'projects', last_ok_at: ago(59) }, { table: 'public.jobs', last_ok_at: ago(5) }], now)).toBeNull();
  });

  it('names each table whose last good copy is over an hour old, or that never had one', () => {
    expect(mirrorWarning([
      { table: 'contacts', last_ok_at: ago(5) },
      { table: 'open_jobs', last_ok_at: ago(61) },
      { table: 'public.jobs', last_ok_at: ago(90) },
    ], now)).toEqual({ tables: ['open_jobs', 'public.jobs'], lastOkAt: ago(90) });
    expect(mirrorWarning([{ table: 'projects', last_ok_at: ago(90) }, { table: 'locations', last_ok_at: null }], now))
      .toEqual({ tables: ['projects', 'locations'], lastOkAt: null });
  });
});
