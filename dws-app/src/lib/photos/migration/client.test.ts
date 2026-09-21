import { describe, expect, it, vi } from 'vitest';
import { createMigrationRequest, loadMigrationBatch, loadMigrationFolders, isPausedMigrationItem, migrationBatchName, migrationBatchStatusLabel, migrationExclusionLabel, migrationItemStatusLabel, type MigrationItem, type MigrationRequest } from './client';

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

  it('loads every folder row, a thousand per request, so 5,000 folders is five requests', async () => {
    const pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 1000 }, (_, n) => ({ id: `row-${page}-${n}` })));
    const request = vi.fn(async (path: string) => {
      const after = new URL(path, 'http://x').searchParams.get('after');
      const index = after ? Number(after.split('-')[1]) + 1 : 0;
      return { folders: pages[index], next_cursor: index < 4 ? pages[index].at(-1)!.id : null };
    });
    const rows = await loadMigrationFolders(request as MigrationRequest, 'batch');
    expect(rows).toHaveLength(5000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[0][0]).toBe('batches/batch/folders?limit=1000');
    expect(request.mock.calls[1][0]).toBe('batches/batch/folders?limit=1000&after=row-0-999');
  });
});

// Baseline finding S7: the import page led with internal vocabulary. Nothing internal reaches the screen.
describe('plain words for the import screen', () => {
  const internal = /_|\b(batch|draft|sealed|inventory|migration|source|lease|claim|revision|interrupted|approved)\b/i;
  it('names every file state without an internal word', () => {
    const states = ['pending', 'hashing', 'waiting_claim', 'uploading', 'finalizing', 'retryable_failed', 'job_conflict', 'restore_required',
      'completed', 'skipped_duplicate', 'skipped_missing', 'skipped_unsupported', 'skipped_failed', 'skipped_user', 'cancelled', 'something_new'];
    for (const state of states) expect(migrationItemStatusLabel(state), state).not.toMatch(internal);
    expect(migrationItemStatusLabel('completed')).toBe('Imported');
    expect(migrationItemStatusLabel('skipped_duplicate')).toBe('Already in DWS Photos');
  });
  it('names the whole import’s state, and lets "needs attention" win', () => {
    expect(['draft', 'approved', 'running', 'interrupted', 'completed', 'cancelled', 'unknown'].map(status => migrationBatchStatusLabel(status)))
      .toEqual(['Not started', 'Importing', 'Importing', 'Paused', 'Finished', 'Cancelled', 'Not started']);
    expect(migrationBatchStatusLabel('running', true)).toBe('Needs attention');
  });
  it('says why files were left out', () => {
    for (const reason of ['picasa_originals', 'picasa_settings', 'hidden_cache', 'unmatched_xmp', 'ambiguous_xmp', 'unsupported_file', 'brand_new_reason']) {
      expect(migrationExclusionLabel(reason), reason).not.toMatch(internal);
    }
  });
  it('names an earlier import by its folders and date, never by id', () => {
    const created_at = '2026-09-20T18:00:00Z';
    expect(migrationBatchName({ script_name: 'migrate_photos', created_at, labels: ['Smith Residence'] }, 'en-US')).toBe('Smith Residence · Sep 20, 2026');
    expect(migrationBatchName({ script_name: 'migrate_photos', created_at, labels: ['A', 'B', 'C', 'D'] }, 'en-US')).toBe('A, B and 2 more · Sep 20, 2026');
    expect(migrationBatchName({ script_name: 'migrate_photos', created_at, labels: [] }, 'en-US')).toBe('Folder import · Sep 20, 2026');
    expect(migrationBatchName({ script_name: 'add_photos', labels: [] })).toBe('Added photos');
  });
});
