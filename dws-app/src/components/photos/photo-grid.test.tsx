// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PhotoGroup } from '@/lib/photos/group';
import type { PhotoRow } from '@/lib/photos/types';

// Each image tile asks for its thumbnail URL once per render, so the number of
// publicUrl calls is the number of tiles that rendered.
const publicUrl = vi.hoisted(() => vi.fn((path: string) => `https://cdn.test/${path}`));
vi.mock('@/lib/photos/urls', () => ({
  publicUrl,
  downloadUrl: () => 'https://cdn.test/download',
  previewUrl: (path: string) => `https://cdn.test/${path}`,
}));

const { default: PhotoGrid } = await import('./photo-grid');
type Selection = NonNullable<React.ComponentProps<typeof PhotoGrid>['selection']>;

function photo(n: number): PhotoRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    job_id: 'job-1',
    uploader_id: 'user-1',
    kind: 'image',
    tags: [],
    captured_at: '2026-08-14T14:41:00.000Z',
    captured_at_source: 'exif',
    original_path: `originals/user-1/${n}/file.jpg`,
    original_bytes: 1000,
    mime_type: 'image/jpeg',
    original_name: `file-${n}.jpg`,
    thumb_path: `derived/user-1/${n}_thumb.webp`,
    preview_path: `derived/user-1/${n}_preview.webp`,
    duration_secs: null,
    sidecar_path: null,
    sidecar_name: null,
    created_at: '2026-08-14T15:00:00.000Z',
    uploader: { full_name: 'Marco Reyes' },
    job: { id: 'job-1', job_number: '3612', name: 'Museum Tower Penthouse' },
  } as PhotoRow;
}

const photos = Array.from({ length: 40 }, (_, i) => photo(i + 1));
const groups: PhotoGroup[] = [
  { key: 'date:a', label: 'August 14, 2026', photos: photos.slice(0, 20) },
  { key: 'date:b', label: 'August 13, 2026', photos: photos.slice(20) },
];
const onOpenPhoto = () => {};

// Like usePhotoSelection: a new object (and new callbacks) on every change.
function selectionOf(ids: string[]): Selection {
  return { selectedIds: new Set(ids), onToggle: () => {}, onToggleGroup: () => {} };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function render(selection: Selection) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoGrid groups={groups} onOpenPhoto={onOpenPhoto} selection={selection} />
      </QueryClientProvider>
    );
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['photo-actor'], { user_id: 'me' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  publicUrl.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('renders every tile once on mount', async () => {
  await render(selectionOf([]));
  expect(publicUrl).toHaveBeenCalledTimes(40);
});

it('re-renders only the ticked tile once a selection is under way', async () => {
  await render(selectionOf([]));
  // The first tick shows every tile's tick box, so every tile renders once.
  await render(selectionOf([photos[0].id]));
  publicUrl.mockClear();
  await render(selectionOf([photos[0].id, photos[25].id]));
  expect(publicUrl).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(2);
});

it('skips the grid when the parent re-renders with the same props', async () => {
  const selection = selectionOf([]);
  await render(selection);
  publicUrl.mockClear();
  await render(selection);
  expect(publicUrl).not.toHaveBeenCalled();
});
