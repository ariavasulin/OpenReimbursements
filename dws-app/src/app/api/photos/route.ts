import { requirePhotoActor } from '@/lib/photos/server/authority';
import { invalidFilter, photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { requirePhotoReader } from '@/lib/photos/server/reads';
import { finalizeUpload } from '@/lib/photos/server/uploads';
import { FAVORITES_EMBED, PHOTO_COLUMNS, PHOTOS_PAGE_SIZE } from '@/lib/photos/apiShared';
import { type PhotoRow } from '@/lib/photos/types';
import { parseLimit } from '@/lib/keysetCursor';
import {
  decodePhotoCursor,
  encodePhotoCursor,
  filteredPhotos,
  listColumns,
  parsePhotoFilters,
  pastPosition,
  resolveSearch,
  type KeysetRow,
} from '@/lib/photos/server/list-filters';

// GET  /api/photos?job=&album=&tags=&uploader=&type=&from=&to=&q=&sort=&cursor=&limit=
//      Active photos, keyset-paginated on (captured_at, id): newest capture
//      first, or oldest first with `sort=asc`; a cursor continues in the
//      direction of the request that carries it. `album=…&sort=custom` lists
//      the album in its arranged order instead, keyset on (position, id); its
//      cursor is marked as a position, so it never continues a date walk (or
//      the reverse: 400). `sort=custom` without `album` is 400. With no filter it lists
//      every photo (the Photos screen). The filters, and how they combine,
//      are documented in lib/photos/server/list-filters.ts, which
//      GET /api/photos/ids shares. Answers no-store, per user (photoJson), and
//      a failure as { error: { code, message } } without database text.
// POST /api/photos — finalize an upload: insert the row for files the browser
//      already put in storage. The row existing is what makes a photo "in".

const MAX_LIMIT = 200;

export async function GET(request: Request) {
  return photoRoute(async () => {
    const supabase = await requirePhotoReader();
    const params = new URL(request.url).searchParams;
    const filters = parsePhotoFilters(params);
    if (typeof filters === 'string') return invalidFilter(filters);
    const limit = parseLimit(params.get('limit'), PHOTOS_PAGE_SIZE, MAX_LIMIT);
    if (limit === null) return invalidFilter('Invalid limit');
    const rawCursor = params.get('cursor');
    const cursor = rawCursor ? decodePhotoCursor(filters, rawCursor) : null;
    if (rawCursor && !cursor) return invalidFilter('Invalid cursor');

    const search = await resolveSearch(supabase, filters);
    // The reader's own favorite on each row; the position only for custom order's cursor.
    const columns = listColumns(filters, PHOTO_COLUMNS, FAVORITES_EMBED);
    const base = filteredPhotos(supabase, filters, search, columns).limit(limit + 1);
    const { data, error } = await (cursor ? pastPosition(base, filters, cursor) : base);
    if (error) throwPhotoDatabaseError(error);

    const rows = (data ?? []) as unknown as (PhotoRow & KeysetRow)[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit ? encodePhotoCursor(filters, last) : null;
    // The position only served the cursor; a list row does not carry it.
    for (const row of rows) delete row.album_position;
    return photoJson({ success: true, photos: page, nextCursor });
  });
}

export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (!body.owner_kind || !body.owner_id || !body.content_sha256) {
      return photoJson({ error: { code: 'conflict', message: 'Reload the application before retrying this upload.', retryable: false } }, 409);
    }
    return photoJson(await finalizeUpload(actor, body));
  });
}
