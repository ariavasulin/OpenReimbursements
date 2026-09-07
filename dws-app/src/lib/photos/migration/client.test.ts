import { describe, expect, it } from 'vitest';
import { isPausedMigrationItem, migrationItemStatusLabel, type MigrationItem } from './client';

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
