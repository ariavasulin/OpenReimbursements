// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AlbumChoice from './album-choice';

// The real query layer, with GET /api/photo-albums answered here: `albums(q)` gives the
// answer for one typed name. A pending promise stands for a slow server.
const albums = vi.fn<(q: string) => unknown>();
const fetchMock = vi.fn(async (url: string) => {
  const q = new URL(url, 'http://test').searchParams.get('q') ?? '';
  const body = await albums(q);
  // A plain object is all fetchJson reads, with no body stream to wait on.
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
});
const lookups = () => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://test').searchParams.get('q'));
let root: Root;
let container: HTMLDivElement;
const changed = vi.fn(), pending = vi.fn();
const input = () => container.querySelector('input')!;
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
/** Past the typing pause, and long enough for the answer to reach the screen. */
const settle = async () => {
  for (let step = 0; step < 5; step++) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
};
const key = async (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(event); });
  return event;
};
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  changed.mockReset(); pending.mockReset(); albums.mockReset(); fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AlbumChoice value={{ kind: 'none' }} onChange={changed} onPendingChange={pending} /></QueryClientProvider>);
  });
  await act(async () => input().focus());
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('never creates on blur before the lookup and supports keyboard selection after refocus', async () => {
  albums.mockResolvedValue({ albums: [{ id: 'existing', name: 'Party', photo_count: 2 }] });
  await type('Party');
  await act(async () => input().blur());
  await settle();
  expect(changed).not.toHaveBeenCalled(); expect(lookups()).not.toContain('Party');
  expect(pending).toHaveBeenLastCalledWith(true);
  await act(async () => input().focus());
  await settle();
  expect(container.querySelectorAll('[role=option]')).toHaveLength(1);
  await key('ArrowDown'); await key('Enter');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'existing', id: 'existing', name: 'Party' });
});

it('ignores an older response even if its fetch does not honor abort, and requires explicit creation', async () => {
  let finishOld!: (result: unknown) => void;
  albums.mockImplementation(q => q === 'Old' ? new Promise(resolve => { finishOld = resolve; }) : { albums: [] });
  await type('Old');
  await settle();
  await type('New');
  await settle();
  await act(async () => finishOld({ albums: [{ id: 'old', name: 'Old', photo_count: 1 }] }));
  expect(container.textContent).not.toContain('Old');
  expect(container.querySelector('[role=option]')?.textContent).toBe('Create album “New”');
  expect(changed).not.toHaveBeenCalled();
  await key('Enter');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'new', name: 'New' });
});

it('keeps the first Escape away from a document-capture dialog handler and releases the second', async () => {
  albums.mockResolvedValue({ albums: [] });
  const dialogEscape = vi.fn();
  document.addEventListener('keydown', dialogEscape, true);
  try {
    await type('Unconfirmed');
    expect((await key('Escape')).defaultPrevented).toBe(true);
    expect(dialogEscape).not.toHaveBeenCalled();
    expect(input().value).toBe('');
    await key('Escape');
    expect(dialogEscape).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  } finally { document.removeEventListener('keydown', dialogEscape, true); }
});

it('asks once per pause in typing, for a small page, and answers a name typed again from cache', async () => {
  albums.mockResolvedValue({ albums: [{ id: 'k', name: 'Kitchen', photo_count: 3 }] });
  await type('K'); await type('Ki'); await type('Kitchen');
  await settle();
  // The blank field asked once on focus; the typed name once after the pause.
  expect(lookups()).toEqual(['', 'Kitchen']);
  expect(new URL(fetchMock.mock.calls[1][0], 'http://test').searchParams.get('limit')).toBe('25');
  expect(container.querySelector('[role=option]')?.textContent).toContain('Kitchen');
  await type('');
  await type('Kitchen');
  await settle();
  // The same name again within a minute is answered from the cache.
  expect(lookups()).toEqual(['', 'Kitchen']);
});

it('lists existing albums when the blank field is focused, before anything is typed', async () => {
  albums.mockResolvedValue({ albums: [{ id: 'k', name: 'Kitchen', photo_count: 3 }, { id: 'd', name: 'Deck', photo_count: 1 }] });
  await act(async () => input().blur());
  await act(async () => input().focus());
  await settle();
  expect(lookups()).toContain('');
  expect([...container.querySelectorAll('[role=option]')].map(option => option.textContent)).toEqual(['Kitchen3 photos', 'Deck1 photo']);
  expect(container.textContent).not.toContain('Create album');
});
