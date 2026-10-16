// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A fake MediaQueryList shared by every matchMedia call, counting listeners.
const mql = {
  matches: true,
  listeners: new Set<() => void>(),
  addEventListener(_: string, listener: () => void) { this.listeners.add(listener); },
  removeEventListener(_: string, listener: () => void) { this.listeners.delete(listener); },
};
const matchMedia = vi.fn(() => mql);
vi.stubGlobal('matchMedia', matchMedia);

const { useDesktop } = await import('./use-desktop');

const seen: boolean[][] = [];
function Probe({ index }: { index: number }) {
  (seen[index] ??= []).push(useDesktop());
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  seen.length = 0;
  mql.matches = true;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

it('reads the real answer on the first client render, with one shared listener', async () => {
  await act(async () => root.render(<><Probe index={0} /><Probe index={1} /><Probe index={2} /></>));
  expect(seen).toEqual([[true], [true], [true]]);
  expect(mql.listeners.size).toBe(1);
  expect(matchMedia).toHaveBeenCalledTimes(1);
});

it('follows a change and drops its listener once nothing reads it', async () => {
  await act(async () => root.render(<><Probe index={0} /><Probe index={1} /></>));
  mql.matches = false;
  await act(async () => mql.listeners.forEach((listener) => listener()));
  expect(seen[0].at(-1)).toBe(false);
  expect(seen[1].at(-1)).toBe(false);
  await act(async () => root.render(<></>));
  expect(mql.listeners.size).toBe(0);
});
