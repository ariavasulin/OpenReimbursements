// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTagChoices } from './tag-dropdown';

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();

function Probe({ jobId }: { jobId?: string | null }) {
  useTagChoices(true, jobId);
  return null;
}

async function render(jobId?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Probe jobId={jobId} /></QueryClientProvider>);
  });
  await act(async () => { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

const answer = (tags: string[]) => new Response(JSON.stringify({ success: true, tags }), { status: 200 });

// Three reads: the project's tags to offer, every tag to match spellings against, and the default tags.
it('asks for one project\'s tags to offer, and every tag to match spellings against, when a project is known', async () => {
  fetchMock.mockImplementation(async () => answer(['punch list']));
  await render('3962-job');
  await act(async () => { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)); });
  expect(fetchMock.mock.calls.map(call => call[0]).sort()).toEqual(['/api/photo-tags', '/api/photo-tags?job=3962-job', '/api/photos/me']);
});

it('asks for every tag with no project', async () => {
  fetchMock.mockImplementation(async () => answer(['roof']));
  for (const jobId of [undefined, null, '']) {
    fetchMock.mockClear();
    await render(jobId);
    expect(fetchMock.mock.calls[0][0], String(jobId)).toBe('/api/photo-tags');
  }
});
