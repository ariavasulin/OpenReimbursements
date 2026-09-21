/** Requests and rendering stay bounded even when an import creates thousands of collections. */
export const COLLECTION_PAGE_SIZE = 200;

export interface CollectionCursor {
  id: string;
  activity: string | null;
  number?: string;
}

export interface CollectionPage<Row> {
  rows: Row[];
  next_cursor: CollectionCursor | null;
}

/** Drain explicit continuations, never infer completion from a short page. */
export async function collectPages<Row extends { id: string }>(
  fetchPage: (cursor: string | null) => Promise<{ rows: Row[]; nextCursor: string | null }>,
): Promise<Row[]> {
  const rows = new Map<string, Row>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page.rows) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) {
      throw new Error('Invalid collection page. Please reload.');
    }
    for (const row of page.rows) rows.set(row.id, row);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (!cursor || cursors.has(cursor)) throw new Error('Collection pagination did not advance. Please reload.');
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return [...rows.values()];
}
