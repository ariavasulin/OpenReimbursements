// @vitest-environment jsdom
import { act, type PointerEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectionTarget } from '@/lib/photos/api';

const prefetchCollection = vi.fn();
vi.mock('@/lib/photos/api', () => ({ prefetchCollection }));

const { usePrefetchOnIntent, HOVER_INTENT_MS } = await import('./use-prefetch-on-intent');

type Handlers = ReturnType<typeof usePrefetchOnIntent>;
let handlers: Handlers = {};
function Probe({ target }: { target?: CollectionTarget }) {
  handlers = usePrefetchOnIntent(target);
  return null;
}

const job: CollectionTarget = { kind: 'job', id: 'job-1' };
const pointer = (pointerType: string) => ({ pointerType }) as PointerEvent;
let root: Root;

async function mount(target?: CollectionTarget) {
  await act(async () => root.render(
    <QueryClientProvider client={new QueryClient()}><Probe target={target} /></QueryClientProvider>
  ));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  prefetchCollection.mockClear();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it('loads after a mouse rests on the link, not when it sweeps past', async () => {
  await mount(job);
  handlers.onPointerEnter!(pointer('mouse'));
  handlers.onPointerLeave!();
  vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
  expect(prefetchCollection).not.toHaveBeenCalled();

  handlers.onPointerEnter!(pointer('mouse'));
  vi.advanceTimersByTime(HOVER_INTENT_MS);
  expect(prefetchCollection).toHaveBeenCalledOnce();
  expect(prefetchCollection.mock.calls[0][1]).toEqual(job);
});

it('ignores pen and touch pointers entering; a finger loads on touch-down at once', async () => {
  await mount(job);
  handlers.onPointerEnter!(pointer('touch'));
  vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
  expect(prefetchCollection).not.toHaveBeenCalled();
  handlers.onTouchStart!();
  expect(prefetchCollection).toHaveBeenCalledOnce();
});

it('waits on focus too, so arrowing past a row does not load it', async () => {
  await mount(job);
  handlers.onFocus!();
  handlers.onBlur!();
  vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
  expect(prefetchCollection).not.toHaveBeenCalled();
  handlers.onFocus!();
  vi.advanceTimersByTime(HOVER_INTENT_MS);
  expect(prefetchCollection).toHaveBeenCalledOnce();
});

it('drops a pending load when the link unmounts', async () => {
  await mount(job);
  handlers.onPointerEnter!(pointer('mouse'));
  await act(async () => root.unmount());
  vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
  expect(prefetchCollection).not.toHaveBeenCalled();
  root = createRoot(document.createElement('div'));
});

it('adds no handlers without a target', async () => {
  await mount(undefined);
  expect(handlers).toEqual({});
});
