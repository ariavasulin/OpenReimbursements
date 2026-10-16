import { MAX_SELECTION_PHOTOS } from '@/lib/photos/apiShared';
import { invalidFilter, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { requirePhotoReader } from '@/lib/photos/server/reads';
import {
  filteredPhotos,
  parsePhotoFilters,
  pastPosition,
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
  return photoRoute(async () => {
    const supabase = await requirePhotoReader();
    const filters = parsePhotoFilters(new URL(request.url).searchParams);
    if (typeof filters === 'string') return invalidFilter(filters);

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
      const { data, error, count } = await (last ? pastPosition(base, filters, rowPosition(filters, last)) : base);
      if (error) throwPhotoDatabaseError(error);
      const rows = (data ?? []) as unknown as KeysetRow[];
      if (total === null) total = count ?? rows.length;
      ids.push(...rows.map((row) => row.id));
      last = rows[rows.length - 1];
      if (rows.length < size) break;
    }
    const matched = total ?? ids.length;
    return photoJson({ ids, total: matched, truncated: matched > ids.length });
  });
}
