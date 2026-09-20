import { describe, expect, it, vi } from 'vitest';
import { createMigrationRequest, loadMigrationBatch, isPausedMigrationItem, migrationItemStatusLabel, type MigrationItem, type MigrationRequest } from './client';

const released = {
  status: 'retryable_failed', error: null, retryable: null,
  retry_after: null, new_attempt_required: false,
} as MigrationItem;

describe('paused migration presentation', () => {
  it('labels an aborted resumable lease as paused only while the batch is interrupted', () => {
    expect(isPausedMigrationItem(released, 'interrupted')).toBe(true);
    expect(isPausedMigrationItem(released, 'running')).toBe(false);
    expect(isPausedMigrationItem(released, 'cancelled')).toBe(false);
  });

  it.each([
    { error: { code: 'Upload permission denied.' } },
    { error: { message: 'Connection failed.' } },
    { error: {} },
    { error_code: 'quota_exceeded' },
    { retryable: true },
    { retryable: false },
    { new_attempt_required: true },
    { retry_after: '2026-09-07T18:00:00.000Z' },
  ])('preserves a recorded failure in an interrupted batch: %j', metadata => {
    const failed = { ...released, ...metadata };
    expect(isPausedMigrationItem(failed, 'interrupted')).toBe(false);
    expect(migrationItemStatusLabel(failed.status)).toBe('Upload failed');
  });

  it('keeps terminal outcomes and unresolved ownership conflicts distinct from pause', () => {
    for (const status of ['completed', 'skipped_duplicate', 'cancelled', 'job_conflict', 'restore_required']) {
      expect(isPausedMigrationItem({ ...released, status }, 'interrupted')).toBe(false);
    }
  });
});

describe('migration control requests', () => {
  it('reuses the encoded inventory body after refreshing authentication', async () => {
    const toJSON = vi.fn(() => ({ entries: [{ relative_path: 'a.jpg' }] }));
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'unauthenticated' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ entry_count: 1 }));
    const refresh = vi.fn(async () => true);
    await expect(createMigrationRequest(refresh, fetchRequest)('sources/source/chunks', { toJSON })).resolves.toEqual({ entry_count: 1 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(toJSON).toHaveBeenCalledOnce();
    expect(fetchRequest.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"entries":[{"relative_path":"a.jpg"}]}', '{"entries":[{"relative_path":"a.jpg"}]}',
    ]);
  });

  it('refreshes counts/items per file and reloads all source pages at batch boundaries', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes('/sources?')) return path.includes('after=')
        ? { sources: [{ id: 'source-2', selection_rules: { tags: ['new'] } }], next_cursor: null }
        : { sources: [{ id: 'source-1' }], next_cursor: 'source-1' };
      if (path.includes('/items?')) return { items: [{ id: 'item' }], next_cursor: null };
      return { batch: { id: 'batch', status: 'running' }, counts: { total: 1 } };
    });
    const progress = await loadMigrationBatch(request as MigrationRequest, 'batch', { after: 'item-0', includeSources: false });
    expect(progress.sources).toBeUndefined();
    expect(progress.view.counts).toEqual({ total: 1 });
    expect(progress.items.items).toEqual([{ id: 'item' }]);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['batches/batch', 'batches/batch/items?limit=50&after=item-0']);
    request.mockClear();
    const transition = await loadMigrationBatch(request as MigrationRequest, 'batch');
    expect(transition.sources).toEqual([{ id: 'source-1' }, { id: 'source-2', selection_rules: { tags: ['new'] } }]);
    expect(request.mock.calls.filter(([path]) => path.includes('/sources?'))).toHaveLength(2);
  });
});
