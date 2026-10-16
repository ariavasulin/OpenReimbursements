// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProjectChoice from './project-choice';

// The real query layer, with GET /api/photo-jobs answered here.
const jobs = [
  { id: 'j1', job_number: '4211', name: 'Smith Residence', location: null, photo_count: 3, thumb_paths: [], latest_activity: null },
  { id: 'j2', job_number: '4100', name: 'Jones Kitchen', location: null, photo_count: 1, thumb_paths: [], latest_activity: null },
];
const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jobs, nextCursor: null }) }) as unknown as Response);
let root: Root;
let container: HTMLDivElement;
const chosen = vi.fn();
const settle = async () => {
  for (let step = 0; step < 3; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
const buttons = () => [...container.querySelectorAll('button')];
const openChooser = async (label: string) => {
  await act(async () => { buttons().find(button => button.getAttribute('aria-label')?.startsWith(label))!.click(); });
  await settle();
};
const options = () => [...container.querySelectorAll('[role=option]')].map(option => option.textContent);

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear(); chosen.mockReset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProjectChoice value={null} ariaLabel="Project for A" onChange={chosen} />
        <ProjectChoice value={null} ariaLabel="Project for B" onChange={chosen} />
      </QueryClientProvider>
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it('loads the projects once for every chooser on the page and searches them as you type', async () => {
  expect(fetchMock).not.toHaveBeenCalled();
  await openChooser('Project for A');
  expect(options()).toEqual(['No project', '4211 · Smith Residence', '4100 · Jones Kitchen']);

  const search = container.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'kitch');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(options()).toEqual(['No project', '4100 · Jones Kitchen']);

  await openChooser('Project for B');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => { buttons().find(button => button.textContent === '4100 · Jones Kitchen')!.click(); });
  // The choice carries only what an import row stores, not the whole project card.
  expect(chosen).toHaveBeenCalledWith({ id: 'j2', job_number: '4100', name: 'Jones Kitchen' });
});
