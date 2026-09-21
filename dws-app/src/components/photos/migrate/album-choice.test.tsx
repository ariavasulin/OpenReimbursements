// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AlbumChoice from './album-choice';

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('@/lib/photos/api', () => ({ fetchJson }));
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
const key = async (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => { input().dispatchEvent(event); });
  return event;
};
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  changed.mockReset(); pending.mockReset(); fetchJson.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<AlbumChoice value={{ kind: 'none' }} onChange={changed} onPendingChange={pending} />); });
  await act(async () => input().focus());
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('never creates on blur before the lookup and supports keyboard selection after refocus', async () => {
  fetchJson.mockResolvedValue({ albums: [{ id: 'existing', name: 'Party', photo_count: 2 }] });
  await type('Party');
  await act(async () => input().blur());
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(changed).not.toHaveBeenCalled(); expect(fetchJson).not.toHaveBeenCalled();
  expect(pending).toHaveBeenLastCalledWith(true);
  await act(async () => input().focus());
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(container.querySelectorAll('[role=option]')).toHaveLength(1);
  await key('ArrowDown'); await key('Enter');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'existing', id: 'existing', name: 'Party' });
});

it('ignores an older response even if its fetch does not honor abort, and requires explicit creation', async () => {
  let finishOld!: (result: unknown) => void;
  fetchJson.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; })).mockResolvedValue({ albums: [] });
  await type('Old');
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await type('New');
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await act(async () => finishOld({ albums: [{ id: 'old', name: 'Old', photo_count: 1 }] }));
  expect(container.textContent).not.toContain('Old');
  expect(container.querySelector('[role=option]')?.textContent).toBe('Create album “New”');
  expect(changed).not.toHaveBeenCalled();
  await key('Enter');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'new', name: 'New' });
});

it('keeps the first Escape away from a document-capture dialog handler and releases the second', async () => {
  fetchJson.mockResolvedValue({ albums: [] });
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
