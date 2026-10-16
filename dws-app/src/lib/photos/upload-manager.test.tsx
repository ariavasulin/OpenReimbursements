// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadOne: vi.fn(), cancel: vi.fn(), session: vi.fn(), invalidate: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
  /** Makes the next load of the upload code fail, like a dropped connection. */
  failLoad: false,
}));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: mocks.session } } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./api', () => ({ invalidateAfterUpload: mocks.invalidate, photoKeys: { detail: (id: string) => ['photo-detail', id] } }));
vi.mock('./upload', async importOriginal => ({ ...await importOriginal<typeof import('./upload')>(), uploadOne: mocks.uploadOne, retrySidecar: vi.fn() }));
vi.mock('./upload-browser', () => ({
  // A getter, so a "failed load" can be switched on and off per test.
  get buildBrowserUploadDeps() {
    if (mocks.failLoad) throw new Error('Failed to fetch dynamically imported module');
    return () => ({});
  },
  cancelBrowserUpload: mocks.cancel,
}));
import { UploadManagerProvider, useUploadManager } from './upload-manager';
import type { UploadIdentity, UploadResult } from './upload';
import type { CancelUploadOutcome } from './upload-contract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const identity: UploadIdentity = { attemptId: 'attempt', photoId: 'photo', contentSha256: 'a'.repeat(64), sourceSignature: JSON.stringify(['a.jpg', 1, 7, 'image/jpeg']) };
let manager: ReturnType<typeof useUploadManager>;
function Consumer() { manager = useUploadManager(); return null; }
let root: Root | undefined;
const mount = async () => { const container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => { root!.render(createElement(UploadManagerProvider, null, createElement(Consumer))); }); };
const enqueue = async () => { await act(async () => { manager.enqueue([{ file: new File(['x'], 'a.jpg', { type: 'image/jpeg', lastModified: 7 }) }], { jobId: 'job' }); }); return manager.items[0].photoId; };

// First in the file: the upload code must not have loaded yet.
describe('the upload code loads on first use', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.session.mockResolvedValue({ data: { session: { user: { id: 'employee' } } } });
  });
  afterEach(async () => { if (root) await act(async () => { root!.unmount(); root = undefined; }); document.body.innerHTML = ''; vi.unstubAllGlobals(); mocks.failLoad = false; });

  it('fails the file with a retry when the code cannot load, and loads it again on retry', async () => {
    mocks.failLoad = true;
    mocks.uploadOne.mockResolvedValue({ status: 'done', warnings: [] });
    await mount();
    const key = await enqueue();
    await vi.waitFor(() => expect(manager.items[0]).toMatchObject({ status: 'failed' }));
    expect(manager.items[0].error).toContain('the upload code did not load');
    expect(mocks.uploadOne).not.toHaveBeenCalled();
    mocks.failLoad = false; // the connection is back
    await act(async () => { manager.retry(key); });
    await vi.waitFor(() => expect(manager.items[0].status).toBe('done'));
    expect(mocks.uploadOne).toHaveBeenCalledTimes(1);
  });
});

describe('ordinary explicit Remove versus incidental unmount', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.session.mockResolvedValue({ data: { session: { user: { id: 'employee' } } } });
  });
  afterEach(async () => { if (root) await act(async () => { root!.unmount(); root = undefined; }); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('aborts immediately, persists a failed removal, and retries cancellation without reuploading', async () => {
    const upload = deferred<UploadResult>(); const cancellation = deferred<CancelUploadOutcome>();
    let signal!: AbortSignal;
    mocks.uploadOne.mockImplementation((_file, _id, _meta, _deps, _progress, options) => { signal = options.signal; options.onIdentity(identity); return upload.promise; });
    mocks.cancel.mockReturnValueOnce(cancellation.promise).mockResolvedValueOnce({ status: 'cancelled' });
    await mount(); const key = await enqueue();
    await act(async () => { manager.remove(key); });
    expect(signal.aborted).toBe(true); expect(manager.items[0].status).toBe('cancelling');
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ attempt_id: identity.attemptId, owner_kind: 'ordinary' }));
    await act(async () => { cancellation.reject(new Error('Offline')); upload.resolve({ status: 'cancelled', warnings: [] }); });
    expect(manager.items[0]).toMatchObject({ status: 'cancel_pending' });
    expect(JSON.parse(localStorage.getItem('photos.upload-manifest')!)[0].status).toBe('cancel_pending');
    await act(async () => { manager.retry(key); });
    expect(mocks.uploadOne).toHaveBeenCalledTimes(1);
    await act(async () => { manager.remove(key); });
    expect(manager.items).toEqual([]); expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });

  it('retains the exact pre-create identity and preserves a finalize winner against a late aborted result', async () => {
    const upload = deferred<UploadResult>();
    mocks.uploadOne.mockImplementation((_file, _id, _meta, _deps, _progress, options) => { options.onIdentity(identity); return upload.promise; });
    mocks.cancel.mockResolvedValue({ status: 'created', photo_id: 'committed', job_id: 'job', warnings: ['Reselect XMP'], sidecar_retry: true });
    await mount(); const key = await enqueue();
    await act(async () => { manager.remove(key); });
    expect(manager.items[0]).toMatchObject({ status: 'done', sidecarRetry: true, warnings: ['Reselect XMP'] });
    await act(async () => { upload.resolve({ status: 'cancelled', warnings: [] }); });
    expect(manager.items[0]).toMatchObject({ status: 'done', sidecarRetry: true });
    await act(async () => { manager.dismissDone(); });
    expect(manager.items).toHaveLength(1);
  });

  it('unmount aborts local work and restores an interrupted resumable item without durable cancellation', async () => {
    const upload = deferred<UploadResult>(); let signal!: AbortSignal;
    mocks.uploadOne.mockImplementation((_file, _id, _meta, _deps, _progress, options) => { signal = options.signal; options.onIdentity(identity); return upload.promise; });
    await mount(); await enqueue();
    await act(async () => { root!.unmount(); root = undefined; });
    expect(signal.aborted).toBe(true); expect(mocks.cancel).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('photos.upload-manifest')!)[0]).toMatchObject({ status: 'interrupted', uploadIdentity: identity });
    upload.resolve({ status: 'cancelled', warnings: [] });
    await mount(); expect(manager.items[0]).toMatchObject({ status: 'interrupted', uploadIdentity: identity });
  });

  it('removes a hashing item before identity exists without starting a server cancellation', async () => {
    const upload = deferred<UploadResult>(); let signal!: AbortSignal;
    mocks.uploadOne.mockImplementation((_file, _id, _meta, _deps, _progress, options) => { signal = options.signal; return upload.promise; });
    await mount(); const key = await enqueue();
    await act(async () => { manager.remove(key); upload.resolve({ status: 'cancelled', warnings: [] }); });
    expect(signal.aborted).toBe(true); expect(manager.items).toEqual([]); expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe('the runner: next file prepared ahead, dropped connections, background previews', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.session.mockResolvedValue({ data: { session: { user: { id: 'employee' } } } });
  });
  afterEach(async () => { if (root) await act(async () => { root!.unmount(); root = undefined; }); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });
  const files = (...names: string[]) => names.map(name => ({ file: new File(['x'], name, { type: 'image/jpeg', lastModified: 7 }) }));

  it('prepares the next file while the current one sends, and hands that preparation to its upload', async () => {
    const first = deferred<UploadResult>();
    const seen: { name: string; prepared?: { source: File } }[] = [];
    mocks.uploadOne.mockImplementation((file: File, _id, _meta, _deps, _progress, options) => {
      seen.push({ name: file.name, prepared: options.prepared });
      if (file.name === 'a.jpg') { options.onStage('sending'); return first.promise; }
      return Promise.resolve({ status: 'done', warnings: [] });
    });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg', 'b.jpg'), { jobId: 'job' }); });
    expect(manager.items[0]).toMatchObject({ status: 'uploading', stage: 'sending' });
    await act(async () => { first.resolve({ status: 'done', warnings: [] }); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['done', 'done']));
    expect(seen.map(s => s.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(seen[1].prepared?.source.name).toBe('b.jpg');
  });

  it('holds the batch on a dropped connection and finishes the same file when it returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tries: string[] = [];
    mocks.uploadOne.mockImplementation(async (file: File, _id, _meta, _deps, _progress, options) => {
      tries.push(file.name);
      if (file.name === 'a.jpg' && tries.length === 1) {
        options.onIdentity(identity);
        return { status: 'failed', error: 'Upload connection interrupted.', errorCode: 'network_error', retryable: true, warnings: [] };
      }
      return { status: 'done', warnings: [] };
    });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg', 'b.jpg'), { jobId: 'job' }); });
    await vi.waitFor(() => expect(manager.items[0]).toMatchObject({ status: 'uploading', stage: 'reconnecting' }));
    expect(tries).toEqual(['a.jpg']); // b waits; it is not failed through in turn
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1_000); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['done', 'done']));
    expect(tries).toEqual(['a.jpg', 'a.jpg', 'b.jpg']);
    // The second try resumes the identity the first one recorded.
    expect(mocks.uploadOne.mock.calls[1][5].identity).toEqual(identity);
  });

  it('after a dropped connection, waits out the lease the cut-off try still holds and carries on (UP-3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answers: UploadResult[] = [
      // The transfer failed offline, and so did the release of its lease.
      { status: 'failed', error: 'Upload connection interrupted.', errorCode: 'storage_upload_failed', retryable: true, heldLease: 4, warnings: [] },
      // Back online, but the hand-back missed (say its lease generation moved on): the lease is still live.
      { status: 'failed', error: 'Waiting for an earlier try of this upload to time out.', errorCode: 'lease_busy', errorStatus: 409, retryable: true, retryAt: Date.now() + 60_000, warnings: [] },
      { status: 'done', warnings: [] },
    ];
    mocks.uploadOne.mockImplementation(async (file: File, _id, _meta, _deps, _progress, options) => {
      if (file.name === 'a.jpg') { options.onIdentity(identity); return answers.shift(); }
      return { status: 'done', warnings: [] };
    });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg', 'b.jpg'), { jobId: 'job' }); });
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1_000); });
    expect(mocks.uploadOne).toHaveBeenCalledTimes(2);
    // The second try hands back the lease the first could not.
    expect(mocks.uploadOne.mock.calls[1][5].heldLease).toBe(4);
    expect(manager.items[0]).toMatchObject({ status: 'uploading', stage: 'reconnecting' });
    // Not failed at the busy lease: it waits for the lease to run out, then finishes.
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(mocks.uploadOne).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['done', 'done']));
    expect(mocks.uploadOne.mock.calls.map(call => (call[0] as File).name)).toEqual(['a.jpg', 'a.jpg', 'a.jpg', 'b.jpg']);
  });

  it('fails a file that can no longer be read at once, instead of holding the batch for it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.uploadOne.mockImplementation(async (file: File) => file.name === 'a.jpg'
      ? { status: 'failed', error: 'Load failed', errorCode: 'storage_upload_failed', retryable: true, warnings: [] }
      : { status: 'done', warnings: [] });
    const [gone, ok] = files('a.jpg', 'b.jpg');
    // What a phone does to a picked file it revoked while the page was in the background.
    gone.file.slice = () => ({ arrayBuffer: () => Promise.reject(new DOMException('The file could not be read', 'NotReadableError')) }) as unknown as Blob;
    await mount();
    await act(async () => { manager.enqueue([gone, ok], { jobId: 'job' }); });
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1_000); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['failed', 'done']));
    expect(manager.items[0].error).toBe('File can no longer be read — re-pick it');
    expect(mocks.uploadOne).toHaveBeenCalledTimes(2); // a once, then b; a was not tried again
  });

  it('refreshes the existing photo a duplicate matched, which may now be in this upload\'s albums', async () => {
    mocks.uploadOne.mockResolvedValue({ status: 'duplicate', canonicalPhotoId: 'existing', warnings: [] });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg'), { jobId: 'job', albumIds: ['album'] }); });
    await vi.waitFor(() => expect(manager.items[0].status).toBe('duplicate'));
    await vi.waitFor(() => expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['photo-detail', 'existing'] }));
    expect(mocks.invalidate).toHaveBeenCalledWith(mocks.queryClient);
  });

  it('a server refusal still fails the file and moves on', async () => {
    mocks.uploadOne.mockImplementation(async (file: File) => file.name === 'a.jpg'
      ? { status: 'failed', error: 'Photo operations are temporarily unavailable.', errorCode: 'temporarily_unavailable', errorStatus: 503, retryable: true, warnings: [] }
      : { status: 'done', warnings: [] });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg', 'b.jpg'), { jobId: 'job' }); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['failed', 'done']));
    expect(mocks.uploadOne).toHaveBeenCalledTimes(2);
  });

  it('clears the preview note once the server made the previews in the background', async () => {
    let derive!: () => Promise<{ thumb_path: string | null }>;
    mocks.uploadOne.mockImplementation(async (_file, _id, _meta, _deps, _progress, options) => {
      options.deriveLater('photo-a', () => new Promise(resolve => { derive = () => { resolve({ thumb_path: 't' }); return Promise.resolve({ thumb_path: 't' }); }; }));
      return { status: 'done', warnings: ['Previews could not be generated; the original is preserved.'] };
    });
    await mount();
    await act(async () => { manager.enqueue(files('a.heic'), { jobId: 'job' }); });
    await vi.waitFor(() => expect(manager.items[0]).toMatchObject({ status: 'done', warnings: ['Previews could not be generated; the original is preserved.'] }));
    await vi.waitFor(() => expect(derive).toBeTypeOf('function'));
    await act(async () => { await derive(); });
    await vi.waitFor(() => expect(manager.items[0].warnings).toEqual([]));
    // The upload refresh, not the everything refresh, plus the photo itself in case it is open.
    expect(mocks.invalidate).toHaveBeenCalledWith(mocks.queryClient);
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['photo-detail', 'photo-a'] });
  });

  it('retry all requeues every failed row', async () => {
    mocks.uploadOne.mockResolvedValue({ status: 'failed', error: 'no', errorCode: 'conflict', errorStatus: 409, retryable: false, warnings: [] });
    await mount();
    await act(async () => { manager.enqueue(files('a.jpg', 'b.jpg'), { jobId: 'job' }); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['failed', 'failed']));
    mocks.uploadOne.mockResolvedValue({ status: 'done', warnings: [] });
    await act(async () => { manager.retryAll(); });
    await vi.waitFor(() => expect(manager.items.map(i => i.status)).toEqual(['done', 'done']));
  });
});
