import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { MAX_SELECTION_PHOTOS } from '@/lib/photos/apiShared';
import {
  afterFilter,
  filteredPhotos,
  parsePhotoFilters,
  resolveSearch,
  rowPosition,
  sortColumn,
  type KeysetRow,
} from '@/lib/photos/server/list-filters';

// GET /api/photos/ids?job=&album=&tags=&uploader=&type=&from=&to=&q=&sort=
//     Every active photo id matching the same filters as GET /api/photos (no
//     cursor, no limit), for "Select all" and a group's header tick:
//     { ids, total, truncated }. At most MAX_SELECTION_PHOTOS ids, in the list's
//     order (an album's arranged order with `sort=custom`); `total` counts every
//     match, and `truncated` says ids stopped short.

/** Rows one walk step reads: PostgREST's own row ceiling. */
const PAGE = 1000;

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const filters = parsePhotoFilters(new URL(request.url).searchParams);
  if (typeof filters === 'string') {
    return NextResponse.json({ error: filters }, { status: 400 });
  }

  try {
    const search = await resolveSearch(supabase, filters);
    const ids: string[] = [];
    let total: number | null = null;
    let last: KeysetRow | undefined;
    const columns = `id, ${sortColumn(filters)}`;
    // Keyset walk on (captured_at, id), or (album_position, id) for custom order;
    // only the first step counts the matches.
    while (ids.length < MAX_SELECTION_PHOTOS) {
      const size = Math.min(PAGE, MAX_SELECTION_PHOTOS - ids.length);
      const counting: { count?: 'exact' } = total === null ? { count: 'exact' } : {};
      const base = filteredPhotos(supabase, filters, search, columns, counting).limit(size);
      const after = last && afterFilter(filters, rowPosition(filters, last));
      const { data, error, count } = await (after ? base.or(after) : base);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as KeysetRow[];
      if (total === null) total = count ?? rows.length;
      ids.push(...rows.map((row) => row.id));
      last = rows[rows.length - 1];
      if (rows.length < size) break;
    }
    const matched = total ?? ids.length;
    return NextResponse.json({ ids, total: matched, truncated: matched > ids.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Listing failed' },
      { status: 500 }
    );
  }
}
