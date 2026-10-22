// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ShopMirrorWarning } from './shop-mirror-warning';

let root: Root;
let container: HTMLDivElement;

async function render(body: unknown, ok = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => body }) as unknown as Response));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><ShopMirrorWarning /></QueryClientProvider>); });
  for (let step = 0; step < 3; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('shows the stale tables and points to the README section', async () => {
  await render({ warning: { tables: ['open_jobs', 'public.jobs'], lastOkAt: null } });
  const alert = container.querySelector('[role=alert]');
  expect(alert?.textContent).toContain('open_jobs');
  expect(alert?.textContent).toContain('public.jobs');
  expect(alert?.textContent).toContain('never');
  expect(alert?.textContent).toContain('shop-bridge/README.md');
});

it('shows nothing when there is no warning', async () => {
  await render({ warning: null });
  expect(container.innerHTML).toBe('');
});

it('shows nothing when the status cannot be read', async () => {
  await render({ error: 'Admin access required' }, false);
  expect(container.innerHTML).toBe('');
});
