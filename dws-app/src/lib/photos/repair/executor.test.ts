import type { SupabaseClient } from '@supabase/supabase-js';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceeded, WorkBudget } from './deadline';
import { downloadOriginal, mediaExecutor, MediaProcessingLimit } from './executor';
import { CAP, poster, probe, transcode } from './transcode';
import type { RepairRow } from './sweep';

vi.mock('./transcode', async importOriginal => ({
  ...await importOriginal<typeof import('./transcode')>(),
  probe: vi.fn(), poster: vi.fn(), transcode: vi.fn(),
}));
const row: RepairRow = {
  id: 'photo', uploader_id: 'user', kind: 'video', mime_type: 'video/mp4',
  original_path: 'user/original.mp4', original_bytes: 4, thumb_path: 'thumb',
  created_at: '2026-01-01T00:00:00Z',
};
const action = { action: 'transcodeVideo' as const, photoId: row.id };
const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'repair-limit-test-')); dirs.push(dir); return join(dir, 'input'); }
function fixture(changed: object | null = { id: row.id }) {
  const update = vi.fn(() => ({ eq: () => ({ is: () => ({ select: () => ({
    abortSignal: () => ({ maybeSingle: async () => ({ data: changed, error: null }) }),
  }) }) }) }));
  const upload = vi.fn().mockResolvedValue({ error: null });
  const admin = { from: () => ({ update }), storage: { from: () => ({
    getPublicUrl: () => ({ data: { publicUrl: 'https://storage.invalid/original' } }), upload,
  }) } } as unknown as SupabaseClient;
  return { admin, update, upload, count: vi.fn() };
}
afterEach(async () => { vi.unstubAllGlobals(); vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('bounded original download', () => {
  it.each([undefined, '1'])('counts streamed bytes even with Content-Length %s', async length => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel: cancelled });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: length ? { 'content-length': length } : {} })));
    const input = await temp();
    await expect(downloadOriginal('https://storage.invalid', input, new WorkBudget(), 12)).rejects.toBeInstanceOf(MediaProcessingLimit);
    expect((await stat(input)).size).toBeLessThanOrEqual(12);
    expect(cancelled).toHaveBeenCalled();
  });
  it('accepts exactly the cap without buffering the whole original', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(12))));
    const input = await temp();
    await downloadOriginal('https://storage.invalid', input, new WorkBudget(), 12);
    expect((await readFile(input)).byteLength).toBe(12);
  });
  it('rejects a known over-cap Content-Length before opening a temp file', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-length': '13' } })));
    const input = await temp();
    await expect(downloadOriginal('https://storage.invalid', input, new WorkBudget(), 12)).rejects.toBeInstanceOf(MediaProcessingLimit);
    await expect(stat(input)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cancelled).toHaveBeenCalled();
  });
});

describe('media executor commits and limits', () => {
  it('skips an over-cap rendition without downloading or downgrading its original', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const f = fixture();
    await mediaExecutor(f.admin, new WorkBudget())([action], { ...row, original_bytes: CAP.bytes + 1 }, f.count);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith({ playback_skipped_reason: `over ${CAP.bytes} bytes` });
    expect(f.count).toHaveBeenCalledWith('playbackSkipped');
  });
  it('persists both cap skips for an oversized video with a missing poster', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const f = fixture();
    await mediaExecutor(f.admin, new WorkBudget())([
      { action: 'makeVideoPoster', photoId: row.id }, action,
    ], { ...row, original_bytes: CAP.bytes + 1, thumb_path: null }, f.count);
    expect(f.count.mock.calls).toEqual([['playbackSkipped'], ['posterSkipped']]);
    expect(f.update).toHaveBeenCalledWith({ poster_skipped_reason: expect.stringContaining(`original exceeds ${CAP.bytes} bytes`) });
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists a poster cap skip when transcoding is not requested', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const f = fixture();
    await mediaExecutor(f.admin, new WorkBudget())([{ action: 'makeVideoPoster', photoId: row.id }],
      { ...row, original_bytes: CAP.bytes + 1, thumb_path: null }, f.count);
    expect(f.count.mock.calls).toEqual([['posterSkipped']]);
    expect(f.update).toHaveBeenCalledWith({ poster_skipped_reason: expect.stringContaining('generate derivatives in the upload client') });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not count a poster cap skip when the photo was trashed concurrently', async () => {
    const f = fixture(null);
    await expect(mediaExecutor(f.admin, new WorkBudget())([{ action: 'makeVideoPoster', photoId: row.id }],
      { ...row, original_bytes: CAP.bytes + 1, thumb_path: null }, f.count)).rejects.toThrow('photo no longer active');
    expect(f.count).not.toHaveBeenCalled();
  });
  it('keeps an ordinary poster processing failure retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('clip')));
    vi.mocked(probe).mockResolvedValue({ durationSecs: 2 });
    vi.mocked(poster).mockRejectedValueOnce(new Error('ffmpeg failed'));
    const f = fixture();
    await expect(mediaExecutor(f.admin, new WorkBudget())([{ action: 'makeVideoPoster', photoId: row.id }], row, f.count)).rejects.toThrow('ffmpeg failed');
    expect(f.count).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it('persists a capped poster output and still completes its independent rendition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('clip')));
    vi.mocked(probe).mockResolvedValue({ durationSecs: 2 });
    vi.mocked(poster).mockImplementationOnce(async (_input, _seek, outputs, _budget, maxBytes) => {
      await Promise.all(outputs.map(async out => { await writeFile(out.path, ''); await truncate(out.path, maxBytes!); }));
    });
    vi.mocked(transcode).mockImplementationOnce(async (_input, output) => { await writeFile(output, 'playback'); });
    const f = fixture();
    await mediaExecutor(f.admin, new WorkBudget())([{ action: 'makeVideoPoster', photoId: row.id }, action], row, f.count);
    expect(f.count.mock.calls).toEqual([['posterSkipped'], ['transcodeVideo']]);
    expect(f.update).toHaveBeenCalledWith({ poster_skipped_reason: expect.stringContaining('output reached') });
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it('does not count a zero-row update as a committed skip', async () => {
    const f = fixture(null);
    await expect(mediaExecutor(f.admin, new WorkBudget())([action], { ...row, original_bytes: CAP.bytes + 1 }, f.count)).rejects.toThrow('photo no longer active');
    expect(f.count).not.toHaveBeenCalled();
  });
  it('rejects an output at the ffmpeg cap before upload or playback metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('clip')));
    vi.mocked(probe).mockResolvedValue({ durationSecs: 2 });
    vi.mocked(transcode).mockImplementation(async (_input, output) => { await writeFile(output, ''); await truncate(output, CAP.bytes); });
    const f = fixture(); const budget = new WorkBudget();
    await expect(mediaExecutor(f.admin, budget)([action], row, f.count)).rejects.toBeInstanceOf(MediaProcessingLimit);
    expect(transcode).toHaveBeenCalledWith(expect.any(String), expect.any(String), budget, CAP.bytes);
    expect(f.upload).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.count).not.toHaveBeenCalled();
  });
  it('rejects an incomplete rendition below the size cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('clip')));
    vi.mocked(probe).mockResolvedValueOnce({ durationSecs: 2 }).mockResolvedValueOnce({ durationSecs: 1 });
    vi.mocked(transcode).mockImplementation(async (_input, output) => { await writeFile(output, 'truncated'); });
    const f = fixture();
    await expect(mediaExecutor(f.admin, new WorkBudget())([action], row, f.count)).rejects.toThrow('rendition is incomplete');
    expect(f.upload).not.toHaveBeenCalled(); expect(f.count).not.toHaveBeenCalled();
  });
  it('retains the poster count when the shared budget expires before rendition', async () => {
    let now = 0;
    const budget = new WorkBudget(0, 240_000, () => now);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('clip')));
    vi.mocked(probe).mockResolvedValue({ durationSecs: 2 });
    vi.mocked(poster).mockImplementation(async (_input, _seek, outputs) => { await Promise.all(outputs.map(out => writeFile(out.path, 'webp'))); });
    const f = fixture();
    f.count.mockImplementation(() => { now = 240_000; });
    await expect(mediaExecutor(f.admin, budget)([{ action: 'makeVideoPoster', photoId: row.id }, action], row, f.count)).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(f.count.mock.calls).toEqual([['makeVideoPoster']]);
    expect(transcode).not.toHaveBeenCalled();
  });
});
