import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationEngine, type MigrationEngineOptions } from './engine';
import { retryDue, type MigrationItem, type MigrationRequest } from './client';
import { uploadOne, type UploadDeps } from '../upload';
import { UploadRequestError } from '../upload-http';

vi.mock('../upload', () => ({ uploadOne: vi.fn() }));
const file = new File(['photo'], 'site.jpg', { type: 'image/jpeg', lastModified: 12 });
const item = (id: string, extra: Partial<MigrationItem> = {}): MigrationItem => ({
  id, source_id: 'source', relative_path: 'site.jpg', original_name: file.name, original_bytes: file.size,
  source_mtime: 12, mime_type: file.type, source_signature: JSON.stringify([file.name, file.size, 12, file.type]),
  revision: 1, photo_id: `photo-${id}`, upload_attempt_id: `attempt-${id}`, content_sha256: null, status: 'pending', ...extra,
});
function setup(rows: MigrationItem[]) {
  const request = vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
    if (path.includes('/items?')) return { items: rows, next_cursor: null };
    if (path === 'batches/batch' && !body) return { counts: { by_status: { completed: rows.length } } };
    return {};
  });
  const options: MigrationEngineOptions = {
    batchId: 'batch', uploaderId: 'actor', sources: [{ id: 'source', batch_id: 'batch', job_id: 'job', kind: 'directory', label: 'Office drive' }],
    localSources: new Map([['source', { kind: 'directory', label: 'Office drive', entries: async function* () {}, getFile: vi.fn(async () => file) }]]),
    request: request as MigrationRequest, deps: {} as UploadDeps, prepare: vi.fn(), onChange: vi.fn(async () => {}), onIdentity: vi.fn(),
  };
  return { options, request, engine: new MigrationEngine(options) };
}

describe('foreground migration scheduler', () => {
  beforeEach(() => { vi.mocked(uploadOne).mockReset(); });

  it('resolves only two files at a time and skips durable completed rows', async () => {
    let active = 0, peak = 0;
    vi.mocked(uploadOne).mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--; return { status: 'done', warnings: [] };
    });
    const { engine, options } = setup([item('done', { status: 'completed' }), ...Array.from({ length: 8 }, (_, i) => item(String(i)))]);
    await engine.run();
    expect(peak).toBe(2); expect(uploadOne).toHaveBeenCalledTimes(8);
    expect(options.localSources.get('source')!.getFile).toHaveBeenCalledTimes(8);
  });

  // photo-albums Decision 10: the folder row, not the picked folder, decides a file's project and tags.
  it('uploads each file under its own folder row’s project and tags, even when that project is empty', async () => {
    vi.mocked(uploadOne).mockResolvedValue({ status: 'done', warnings: [] });
    const folder = (path: string, job_id: string | null, tags: string[]) =>
      ({ id: `row-${path}`, source_id: 'source', folder: path, album_name: path || 'Office drive', album_id: null, job_id, tags, photo_count: 1 });
    const { options } = setup([item('root'), item('smith', { relative_path: 'Smith/Finished/site.jpg' }), item('party', { relative_path: 'Party/site.jpg' }),
      item('legacy', { relative_path: 'No row here/site.jpg' })]);
    options.sources[0].selection_rules = { tags: ['from-the-source'] };
    options.folders = [folder('', 'job-root', []), folder('Smith/Finished', 'job-smith', ['professional']), folder('Party', null, ['office'])];
    await new MigrationEngine(options).run();
    const sent = Object.fromEntries(vi.mocked(uploadOne).mock.calls.map(call => [call[1], { jobId: call[2].jobId, tags: call[2].tags }]));
    expect(sent).toEqual({
      'attempt-root': { jobId: 'job-root', tags: [] },
      'attempt-smith': { jobId: 'job-smith', tags: ['professional'] },
      // Reviewed as "No project": the row wins over the picked folder's own project.
      'attempt-party': { jobId: null, tags: ['office'] },
      // No row at all (scanned before folder rows existed): the picked folder's project and tags, as before.
      'attempt-legacy': { jobId: 'job', tags: ['from-the-source'] },
    });
  });

  it('does not retry before durable Retry-After or automatically retry a permanent failure', async () => {
    const { engine } = setup([item('future', { retry_after: new Date(Date.now() + 60_000).toISOString() }), item('permanent', { status: 'retryable_failed', retryable: false })]);
    await engine.run(); expect(uploadOne).not.toHaveBeenCalled();
    expect(retryDue(item('past', { retry_after: new Date(Date.now() - 1).toISOString() }))).toBe(true);
  });

  it('refreshes A immediately while B remains in flight', async () => {
    let finishB!: () => void;
    const waitingB = new Promise<void>(resolve => { finishB = resolve; });
    vi.mocked(uploadOne).mockImplementation(async (_file, queueId) => {
      if (queueId === 'attempt-b') await waitingB;
      return { status: 'done', warnings: [] };
    });
    const { engine, options } = setup([item('a'), item('b')]);
    const work = engine.run();
    await vi.waitFor(() => expect(options.onChange).toHaveBeenCalledWith('a'));
    expect(options.onChange).not.toHaveBeenCalledWith('b');
    finishB(); await work;
    expect(options.onChange).toHaveBeenCalledWith('b');
  });

  it('pause aborts a disconnected source read without scheduling more files', async () => {
    const { engine, options, request } = setup([item('a'), item('b'), item('c')]);
    options.localSources.get('source')!.getFile = vi.fn(() => new Promise<File>(() => {}));
    const work = engine.run();
    await new Promise(resolve => setTimeout(resolve, 0)); engine.stop();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploadOne).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith('batches/batch', { action: 'complete' }, expect.anything());
  });

  it('changed source metadata requires rescan before upload or stable path reuse', async () => {
    const { engine } = setup([item('changed', { source_signature: 'old signature' })]);
    await expect(engine.run()).rejects.toThrow('fresh file revision'); expect(uploadOne).not.toHaveBeenCalled();
  });

  it('prepares authoritative stable identities before byte transfers and fences persisted failure with its lease', async () => {
    const { engine, options, request } = setup([item('a')]);
    options.prepare = vi.fn(async () => ({ owner_kind: 'migration' as const, owner_id: 'a', photo_id: 'photo-a', job_id: 'job', content_sha256: 'a'.repeat(64), original_path: 'original', thumb_path: 'thumb', preview_path: 'preview', sidecar_path: 'sidecar', result: null }));
    options.deps.acquireLease = vi.fn(async () => ({ status: 'acquired' as const, lease_generation: 4, lease_expires_at: new Date().toISOString() }));
    vi.mocked(uploadOne).mockImplementation(async (_file, _queue, _meta, deps) => {
      const prepared = await deps.createAttempt({ attempt_id: 'attempt-a', photo_id: 'attempt-a', job_id: 'job', source_signature: item('a').source_signature, content_sha256: 'a'.repeat(64), original_name: file.name, original_bytes: file.size, mime_type: file.type });
      await deps.acquireLease(prepared);
      return { status: 'failed', error: 'Quota exceeded', retryable: false, warnings: [] };
    });
    await engine.run();
    expect(options.prepare).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'a', attempt_id: 'attempt-a', photo_id: 'photo-a' }), undefined);
    expect(options.onIdentity).toHaveBeenCalledWith('a', expect.objectContaining({ attemptId: 'attempt-a', photoId: 'photo-a' }));
    expect(request).toHaveBeenCalledWith('items/a', expect.objectContaining({ action: 'outcome', lease_generation: 4, retryable: false }), expect.anything());
  });

  it('does not claim completion when another page rejects the observed generation', async () => {
    const { engine, request } = setup([item('a')]);
    request.mockImplementation(async (path: string) => {
      if (path === 'items/a') throw new UploadRequestError('Lease busy', { code: 'conflict', status: 409, retryable: false });
      return { items: [item('a')], next_cursor: null };
    });
    vi.mocked(uploadOne).mockResolvedValue({ status: 'failed', error: 'Lease is busy', warnings: [] });
    await expect(engine.run()).rejects.toMatchObject({ name: 'MigrationLeaseUnavailable' });
    expect(request).toHaveBeenCalledWith('items/a', expect.objectContaining({ lease_generation: 0 }), expect.anything());
    expect(request.mock.calls.some(([, body]) => (body as { action?: string })?.action === 'complete')).toBe(false);
  });

  it('does not call complete while conflicts or deferred retries remain', async () => {
    const { engine, request } = setup([]);
    request.mockImplementation(async (path: string) => path.includes('/items?') ? { items: [], next_cursor: null } : { counts: { by_status: { job_conflict: 1 } } });
    await expect(engine.run()).rejects.toThrow('1 job conflict');
    expect(request.mock.calls.some(([, body]) => (body as { action?: string })?.action === 'complete')).toBe(false);
  });
});
