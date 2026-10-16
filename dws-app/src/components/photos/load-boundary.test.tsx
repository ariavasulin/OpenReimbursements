// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import dynamic from 'next/dynamic';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const { LoadBoundary, LOAD_FAILED_MESSAGE, retryableLoader } = await import('./load-boundary');

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // React logs the error a boundary catches; the test expects it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  toastError.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Part({ label }: { label: string }) {
  return <p>{label}</p>;
}

/** The parent's half: unmount on failure, mount again on the next open. */
function Host({ Lazy, onError }: { Lazy: React.ComponentType<{ label: string }>; onError(): void }) {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setMounted(true)}>open</button>
      <span>grid</span>
      {mounted && (
        <LoadBoundary
          onError={() => {
            onError();
            setMounted(false);
          }}
        >
          <Lazy label="viewer" />
        </LoadBoundary>
      )}
    </>
  );
}

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

it('keeps the page when a part fails to download, and the next open downloads it again', async () => {
  const failure = new Error('ChunkLoadError: Loading chunk 123 failed.');
  let attempts = 0;
  let online = false;
  const load = vi.fn(() => {
    attempts += 1;
    return online ? Promise.resolve({ default: Part }) : Promise.reject(failure);
  });
  const Lazy = dynamic(retryableLoader(load), { ssr: false, loading: () => null });
  const onError = vi.fn();

  await act(async () => root.render(<Host Lazy={Lazy} onError={onError} />));
  await flush();

  // The first download and the stand-in's one quick retry both failed: the
  // boundary caught it, the page is still there, and one toast says so.
  expect(container.textContent).toContain('grid');
  expect(container.textContent).not.toContain('viewer');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(toastError).toHaveBeenCalledTimes(1);
  expect(toastError.mock.calls[0][0]).toBe(LOAD_FAILED_MESSAGE);
  expect(attempts).toBe(2);

  // Back online, the next open asks the network again (React.lazy alone would
  // rethrow the remembered failure) and draws the part.
  online = true;
  await act(async () => container.querySelector('button')!.click());
  await flush();
  expect(attempts).toBe(3);
  expect(container.textContent).toContain('viewer');
  expect(onError).toHaveBeenCalledTimes(1);
});

it('stays quiet when told the failed download was not asked for', async () => {
  const Lazy = dynamic(retryableLoader<{ label: string }>(() => Promise.reject(new Error('offline'))), { ssr: false, loading: () => null });
  const onError = vi.fn();
  await act(async () =>
    root.render(
      <LoadBoundary notify={false} onError={onError}>
        <Lazy label="viewer" />
      </LoadBoundary>
    )
  );
  await flush();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(toastError).not.toHaveBeenCalled();
});

it('passes a successful download straight through', async () => {
  const load = vi.fn(() => Promise.resolve({ default: Part }));
  const Lazy = dynamic(retryableLoader(load), { ssr: false, loading: () => null });
  await act(async () => root.render(<LoadBoundary><Lazy label="viewer" /></LoadBoundary>));
  await flush();
  expect(container.textContent).toBe('viewer');
  expect(load).toHaveBeenCalledTimes(1);
});
