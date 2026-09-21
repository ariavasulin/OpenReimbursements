import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPages } from './collectionPagination';
import { fetchAlbums, fetchJobs } from './api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('collection pagination', () => {
  it.each(['albums', 'jobs'] as const)('loads >1000 %s and keeps the search on every request, even with short pages', async (kind) => {
    const all = Array.from({ length: 1203 }, (_, i) => ({ id: String(i), name: 'same name' }));
    const search = '100%_done & more';
    const requests: URL[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push(url);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = Math.min(start + 73, all.length); // shorter than requested does NOT mean EOF
      return Response.json({ [kind]: all.slice(start, end), nextCursor: end === all.length ? null : String(end) });
    });
    const result = await (kind === 'albums' ? fetchAlbums(search) : fetchJobs(search));
    expect(result).toEqual(all);
    expect(requests.length).toBeGreaterThan(10);
    expect(requests.every(url => url.searchParams.get('q') === search && url.searchParams.get('limit') === '200')).toBe(true);
  });

  it('fails on a broken continuation rather than publishing silently truncated results', async () => {
    await expect(collectPages(async () => ({ rows: [], nextCursor: 'repeated' }))).rejects.toThrow('did not advance');
    await expect(collectPages(async () => ({ rows: [], nextCursor: undefined as unknown as null }))).rejects.toThrow('Invalid collection page');
  });

  it('deduplicates a row that moves across pages while the library changes', async () => {
    expect(await collectPages(async (cursor) => cursor === null
      ? { rows: [{ id: 'a' }], nextCursor: 'next' }
      : { rows: [{ id: 'a' }, { id: 'b' }], nextCursor: null })).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
