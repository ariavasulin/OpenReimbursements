import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { collectionNextCursor, readCollectionPage } from './collectionPagination';

const id = '660f88ae-07d3-4d1e-ab0f-af0a77410120';

describe('collection cursor boundary', () => {
  it('retains the exact microsecond timestamp and binds cursors to search and collection', () => {
    const key = { id, activity: '2040-01-01T00:00:00.000001+00:00' };
    const cursor = collectionNextCursor('albums', 'search %_', key)!;
    const params = new URLSearchParams({ q: ' search %_ ', cursor, limit: '17' });
    expect(readCollectionPage(params, 'albums')).toEqual({ q: 'search %_', limit: 17, cursor: key });
    expect(() => readCollectionPage(params, 'jobs')).toThrow('Invalid request');
    params.set('q', 'different');
    expect(() => readCollectionPage(params, 'albums')).toThrow('Invalid request');
  });

  it('accepts null job activity and rejects null album activity', () => {
    const key = { id, activity: null, number: '00000000000000000001' };
    const cursor = collectionNextCursor('jobs', '', key)!;
    expect(readCollectionPage(new URLSearchParams({ cursor }), 'jobs').cursor).toEqual(key);
    const albumCursor = collectionNextCursor('albums', '', key)!;
    expect(() => readCollectionPage(new URLSearchParams({ cursor: albumCursor }), 'albums')).toThrow('Invalid request');
    expect(collectionNextCursor('jobs', '', null)).toBeNull();
  });

  it('rejects malformed cursor fields and duplicate or excessive parameters', () => {
    for (const key of [{ id: 'invalid', activity: null, number: 'a' }, { id, activity: 'yesterday', number: 'a' },
      { id, activity: null }, { id, activity: '2040-02-31T00:00:00Z', number: 'a' }]) {
      const cursor = Buffer.from(JSON.stringify({ v: 1, kind: 'jobs', q: '', key })).toString('base64url');
      expect(() => readCollectionPage(new URLSearchParams({ cursor }), 'jobs')).toThrow('Invalid request');
    }
    for (const raw of ['cursor=', 'limit=201', 'limit=0', 'limit=1.2', 'limit=1e2', 'q=a&q=b', 'cursor=a&cursor=b']) {
      expect(() => readCollectionPage(new URLSearchParams(raw), 'jobs')).toThrow('Invalid request');
    }
  });
});
