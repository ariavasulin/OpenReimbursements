import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { finalizeUpload } from '@/lib/photos/server/uploads';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { PHOTO_COLUMNS, PHOTOS_PAGE_SIZE } from '@/lib/photos/apiShared';
import { type PhotoRow } from '@/lib/photos/types';
import { parseLimit } from '@/lib/keysetCursor';
import {
  afterFilter,
  decodePhotoCursor,
  encodePhotoCursor,
  filteredPhotos,
  parsePhotoFilters,
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
//      GET /api/photos/ids shares.
// POST /api/photos — finalize an upload: insert the row for files the browser
//      already put in storage. The row existing is what makes a photo "in".

const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const filters = parsePhotoFilters(params);
  if (typeof filters === 'string') {
    return NextResponse.json({ error: filters }, { status: 400 });
  }
  const limit = parseLimit(params.get('limit'), PHOTOS_PAGE_SIZE, MAX_LIMIT);
  if (limit === null) {
    return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
  }
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodePhotoCursor(filters, rawCursor) : null;
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
  }

  let search: string[];
  try {
    search = await resolveSearch(supabase, filters);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Search failed' },
      { status: 500 }
    );
  }

  const columns = filters.custom ? `${PHOTO_COLUMNS}, album_position` : PHOTO_COLUMNS;
  let query = filteredPhotos(supabase, filters, search, columns).limit(limit + 1);
  if (cursor) {
    // Separate or() calls are ANDed by PostgREST, so this composes with the filters.
    query = query.or(afterFilter(filters, cursor));
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as (PhotoRow & KeysetRow & { albums?: unknown })[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit ? encodePhotoCursor(filters, last) : null;
  // The join column only served the album filter, and the position only the
  // cursor; a list row carries neither.
  for (const row of rows) {
    delete row.albums;
    delete row.album_position;
  }

  return NextResponse.json({ success: true, photos: page, nextCursor });
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
