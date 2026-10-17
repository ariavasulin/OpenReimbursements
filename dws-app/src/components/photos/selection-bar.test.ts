import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ removePhotosFromLists: vi.fn(), invalidatePhotoCaches: vi.fn() }));
vi.mock('@/lib/photos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/photos/api')>()),
  ...api,
}));

const { afterTrash } = await import('./selection-bar');
const queryClient = new QueryClient();

beforeEach(() => {
  api.removePhotosFromLists.mockClear();
  api.invalidatePhotoCaches.mockClear();
});

it('drops the moved photos without re-downloading when every one moved', () => {
  afterTrash(queryClient, 2, { photoIds: ['a', 'b'], leftOut: 0, failed: 0 });
  expect(api.removePhotosFromLists).toHaveBeenCalledWith(queryClient, ['a', 'b']);
  expect(api.invalidatePhotoCaches).not.toHaveBeenCalled();
});

it('asks every grid again when some were already trashed by someone else', () => {
  // Sent 5; 3 were in Trash already, so the server neither moved nor counted them.
  afterTrash(queryClient, 5, { photoIds: ['a', 'b'], leftOut: 0, failed: 0 });
  expect(api.removePhotosFromLists).toHaveBeenCalledWith(queryClient, ['a', 'b']);
  expect(api.invalidatePhotoCaches).toHaveBeenCalledWith(queryClient);
});

it('asks every grid again when none moved', () => {
  afterTrash(queryClient, 3, { photoIds: [], leftOut: 2, failed: 1 });
  expect(api.invalidatePhotoCaches).toHaveBeenCalledWith(queryClient);
});
