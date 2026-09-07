import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WorkBudget, DeadlineExceeded } from './deadline';
import { runRepair, removeConfirmed } from './run';
import { planSweep, type RepairRow } from './sweep';

const row = (id: string): RepairRow => ({ id, uploader_id: 'owner', kind: 'video', mime_type: 'video/mp4', original_path: `originals/owner/${id}/clip.mp4`, original_bytes: 12, thumb_path: null, created_at: '2020-01-01T00:00:00Z' });
function fixture(rows: RepairRow[] = []) {
  const progress = { lease_generation: 1, photo_cursor: null as { after: string } | null, storage_cursor: null as { after: string } | null };
  const checkpoints: unknown[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'photo_repair_acquire') return { data: { ...progress }, error: null };
    if (name === 'photo_repair_claim_purge') return { data: [], error: null };
    if (name === 'photo_repair_backlog') return { data: { purge_backlog: 0, oldest_due_at: null }, error: null };
    if (name === 'photo_repair_storage_page') return { data: [], error: null };
    if (name === 'photo_repair_checkpoint') {
      progress.photo_cursor = args.p_photo_cursor as typeof progress.photo_cursor;
      progress.storage_cursor = args.p_storage_cursor as typeof progress.storage_cursor;
      checkpoints.push(structuredClone(args));
    }
    return { data: true, error: null };
  });
  const exists = vi.fn(async () => ({ data: true, error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const cursors: unknown[] = [];
  const from = vi.fn(() => {
    let after: string | null = null;
    const query = {
      select: () => query, is: () => query, or: () => query, order: () => query, limit: () => query,
      gt: (_: string, value: string) => { after = value; return query; },
      then: (resolve: (result: unknown) => unknown) => {
        cursors.push(after);
        return Promise.resolve(resolve({ data: rows.filter(r => !after || r.id > after), error: null }));
      },
    };
    return query;
  });
  const admin = { rpc: (name: string, args: Record<string, unknown>) => {
    const result = rpc(name, args);
    return Object.assign(result, { select: () => result });
  }, from, storage: { from: () => ({ exists, remove }) } } as unknown as SupabaseClient;
  return { admin, progress, checkpoints, rpc, exists, remove, cursors, from };
}

describe('one bounded repair lifecycle (AC-10)', () => {
  it('purge consumes the original budget and video receives only its remainder', async () => {
    let now = 0;
    const f = fixture([row('video')]);
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === 'photo_repair_claim_purge') now = 239_999;
      return result;
    });
    const budget = new WorkBudget(0, 240_000, () => now);
    const media = vi.fn(async () => { expect(budget.remaining()).toBe(1); now++; budget.check(); });
    const result = await runRepair(f.admin, budget, { executeMedia: media });
    expect(media).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.report.errors).toEqual([]);
    expect(result.report.work_deferred).toBeGreaterThan(0);
    expect(f.progress.photo_cursor).toBeNull();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('checkpoints the last completed photo and resumes the interrupted item after process restart', async () => {
    let now = 0;
    const f = fixture([row('a'), row('b')]);
    const first = await runRepair(f.admin, new WorkBudget(0, 240_000, () => now), {
      executeMedia: async (_actions, item, count) => {
        if (item.id === 'b') { now = 240_000; throw new DeadlineExceeded(); }
        count('makeVideoPoster');
      },
    });
    expect(first.report.counts.makeVideoPoster).toBe(1);
    expect(f.progress.photo_cursor).toEqual({ after: 'a' });
    now = 0;
    const completed: string[] = [];
    await runRepair(f.admin, new WorkBudget(0, 240_000, () => now), { executeMedia: async (_a, item) => { completed.push(item.id); } });
    expect(completed).toEqual(['b']);
    expect(f.cursors).toEqual([null, 'a']);
    expect(f.progress.photo_cursor).toBeNull();
  });

  it('a partial failing Storage inventory cannot turn a confirmed live original into a dead row', async () => {
    const f = fixture([row('alive')]);
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => name === 'photo_repair_storage_page'
      ? { data: null, error: { message: 'partial upstream inventory' } } as never : original(name, args));
    const result = await runRepair(f.admin, new WorkBudget(), { executeMedia: async () => {} });
    expect(result.status).toBe(500);
    expect(f.exists).toHaveBeenCalledWith(row('alive').original_path);
    expect(f.rpc.mock.calls.some(([name]) => name === 'photo_repair_delete_dead')).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('overlapping owner defers without querying photos or Storage', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null, error: null } as never);
    const result = await runRepair(f.admin, new WorkBudget());
    expect(result.report.work_deferred).toBe(1);
    expect(f.cursors).toEqual([]);
    expect(f.exists).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('a lost lease stops scheduling immediately instead of trying the remaining purge rows', async () => {
    const f = fixture();
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => {
      if (name === 'photo_repair_claim_purge') return { data: [{ id: 'a', original_path: 'a' }, { id: 'b', original_path: 'b' }], error: null } as never;
      if (name === 'photo_repair_authorize_delete') return { data: null, error: { message: 'stale_lease' } } as never;
      return original(name, args);
    });
    const result = await runRepair(f.admin, new WorkBudget());
    expect(result.status).toBe(500);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'photo_repair_authorize_delete')).toHaveLength(1);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.from).not.toHaveBeenCalled();
  });

  it('a persistent poster cap skip does not replan the unsupported poster or change video identity', () => {
    const video = { ...row('capped'), original_bytes: 300 * 1024 * 1024,
      poster_skipped_reason: 'over 209715200 bytes', playback_skipped_reason: 'over 209715200 bytes' };
    expect(planSweep([video], [{ name: video.original_path, created_at: video.created_at, has_row: true }], Date.now(), { transcode: true })).toEqual([]);
    expect(video.kind).toBe('video');
  });

  it('bounds error details while preserving the exact number of failures', async () => {
    const f = fixture(Array.from({ length: 80 }, (_, i) => row(String(i).padStart(3, '0'))));
    const result = await runRepair(f.admin, new WorkBudget(), { executeMedia: async () => { throw new Error('x'.repeat(10_000)); } });
    expect(result.status).toBe(500);
    expect(result.report.error_count).toBe(80);
    expect(result.report.errors).toHaveLength(50);
    expect(result.report.errors.every(error => error.length <= 1_000)).toBe(true);
  });

  it('Storage partial success is an error until exact HEAD confirms absence, with missing-path retry idempotent', async () => {
    const f = fixture();
    await expect(removeConfirmed(f.admin, 'originals/partial')).rejects.toThrow('object remains');
    f.exists.mockResolvedValue({ data: false, error: null });
    await expect(removeConfirmed(f.admin, 'originals/partial')).resolves.toBeUndefined();
    expect(f.remove).toHaveBeenCalledTimes(2);
  });
});
