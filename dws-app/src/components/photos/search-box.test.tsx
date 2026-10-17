// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/photos',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const { default: SearchBox } = await import('./search-box');
const { PhotosSearchProvider } = await import('./photos-shell-context');

const job = (n: number) => ({ id: `j${n}`, name: `Kitchen ${n}`, job_number: String(n), photo_count: 1 });
const album = (n: number) => ({ id: `a${n}`, name: `Kitchen album ${n}`, photo_count: 2 });

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn(async (url: string) => {
  const body = url.startsWith('/api/photo-jobs')
    ? { jobs: [1, 2, 3, 4, 5, 6].map(job), nextCursor: 'more' }
    : { albums: [1, 2].map(album), nextCursor: null };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={new QueryClient()}>
      <PhotosSearchProvider><SearchBox /></PhotosSearchProvider>
    </QueryClientProvider>
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function type(text: string) {
  const input = container.querySelector('input')!;
  await act(async () => input.focus());
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Past the 250 ms debounce, then let the requests settle.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it('asks for only the rows it shows: one small request per list, not every page', async () => {
  await type('kitchen');
  const urls = fetchMock.mock.calls.map(([url]) => url);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('q')).toBe('kitchen');
    expect(params.get('limit')).toBe('5');
    expect(params.has('cursor')).toBe(false);
  }
  const projects = container.querySelectorAll('section[aria-label="Projects"] a');
  const albums = container.querySelectorAll('section[aria-label="Albums"] a');
  expect(projects).toHaveLength(5);
  expect(albums).toHaveLength(2);
});
