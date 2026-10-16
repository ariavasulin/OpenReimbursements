// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadOne: vi.fn(), cancel: vi.fn(), session: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: mocks.session } } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./api', () => ({ invalidatePhotoCaches: mocks.invalidate }));
vi.mock('./upload', async importOriginal => ({ ...await importOriginal<typeof import('./upload')>(), uploadOne: mocks.uploadOne, retrySidecar: vi.fn() }));
vi.mock('./upload-browser', () => ({ buildBrowserUploadDeps: () => ({}), cancelBrowserUpload: mocks.cancel }));
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
    expect(mocks.invalidate).toHaveBeenCalled();
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
