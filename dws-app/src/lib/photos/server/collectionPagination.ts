import { validate as isUuid } from 'uuid';
import { z } from 'zod';
import { COLLECTION_PAGE_SIZE, type CollectionCursor } from '../collectionPagination';
import { PhotoApiError } from './http';

type Kind = 'albums' | 'jobs';
const timestampSchema = z.string().datetime({ offset: true });
const timestamp = (value: unknown): value is string => timestampSchema.safeParse(value).success;

/** Bind the opaque continuation to its collection and exact search, preserving PostgreSQL microseconds. */
export function readCollectionPage(params: URLSearchParams, kind: Kind) {
  for (const key of ['q', 'cursor', 'limit']) {
    if (params.getAll(key).length > 1) throw new PhotoApiError('invalid_input');
  }
  const q = params.get('q')?.trim() ?? '';
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? COLLECTION_PAGE_SIZE : Number(rawLimit);
  if (q.length > 1000 || (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) ||
      !Number.isInteger(limit) || limit < 1 || limit > COLLECTION_PAGE_SIZE) throw new PhotoApiError('invalid_input');
  let cursor: CollectionCursor | null = null;
  if (params.has('cursor')) {
    const encoded = params.get('cursor')!;
    try {
      if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      const key = value.key;
      if (value.v !== 1 || value.kind !== kind || value.q !== q || !key ||
          typeof key.id !== 'string' || !isUuid(key.id) ||
          !(timestamp(key.activity) || (kind === 'jobs' && key.activity === null)) ||
          (kind === 'jobs' && (typeof key.number !== 'string' || key.number.length > 1000))) throw new Error();
      cursor = key;
    } catch { throw new PhotoApiError('invalid_input'); }
  }
  return { q, limit, cursor };
}

export function collectionNextCursor(kind: Kind, q: string, key: CollectionCursor | null): string | null {
  return key === null ? null : Buffer.from(JSON.stringify({ v: 1, kind, q, key })).toString('base64url');
}
