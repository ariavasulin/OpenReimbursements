import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { finalizeUpload } from '@/lib/photos/server/uploads';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { validate as isUuid } from 'uuid';
import {
  escapeForIlike,
  escapeIlikeWildcards,
  PHOTO_COLUMNS,
  PHOTOS_PAGE_SIZE,
} from '@/lib/photos/apiShared';
import {
  type PhotoRow,
  type PhotoTagRow,
} from '@/lib/photos/types';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  isIsoTimestamp,
  keysetOrFilter,
  parseLimit,
} from '@/lib/keysetCursor';

// GET  /api/photos?job=&tags=&uploader=&q=&cursor=&limit=
//      Filtered photo list, newest capture first, keyset-paginated on
//      (captured_at, id). `q` searches across job number/name, uploader name,
//      and tag membership (ILIKE — no search infrastructure at DWS scale).
// POST /api/photos — finalize an upload: insert the row for files the browser
//      already put in storage. The row existing is what makes a photo "in".

const MAX_LIMIT = 200;
// Upper bound on tags spliced into one or() filter — a URL-length guard, not a
// recall choice; the type-ahead (/api/photo-tags) is unbounded.
const MAX_SEARCH_TAGS = 500;

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Resolve a free-text query into a PostgREST or() filter over photos:
 * matching job ids, matching uploader ids, and overlapping tags.
 * Returns null when nothing matches (the result set is empty).
 *
 * `job` scopes the tag lookup, which would otherwise unnest the tags of every
 * row in photos to answer a question scoped to one job.
 */
async function buildSearchFilter(
  supabase: ServerClient,
  q: string,
  job: string | null
): Promise<string | null> {
  const escaped = escapeForIlike(q);
  if (!escaped) return null;
  const rpcQuery = escapeIlikeWildcards(q);
  const pattern = `%${escaped}%`;

  const [jobsResult, uploadersResult, tagRowsResult] = await Promise.all([
    supabase
      .from('jobs')
      .select('id')
      .or(`job_number.ilike.${pattern},name.ilike.${pattern}`)
      .limit(200),
    supabase
      .from('user_profiles')
      .select('user_id')
      .ilike('full_name', pattern)
      .limit(200),
    supabase.rpc('get_photo_tags', { job_filter: job || null, q: rpcQuery }),
  ]);

  const firstError =
    jobsResult.error ?? uploadersResult.error ?? tagRowsResult.error;
  if (firstError) throw new Error(firstError.message);

  const parts: string[] = [];

  const jobIds = (jobsResult.data ?? []).map((row) => row.id);
  if (jobIds.length > 0) parts.push(`job_id.in.(${jobIds.join(',')})`);

  const uploaderIds = (uploadersResult.data ?? []).map((row) => row.user_id);
  if (uploaderIds.length > 0) {
    parts.push(`uploader_id.in.(${uploaderIds.join(',')})`);
  }

  // Drop tags that can't be embedded in PostgREST's or()/array syntax. The UI
  // never produces those, so skipping is the safe trade.
  const matchedTags = ((tagRowsResult.data ?? []) as PhotoTagRow[])
    .map((row) => row.tag)
    .filter((tag) => !/[,(){}"\\]/.test(tag))
    .slice(0, MAX_SEARCH_TAGS);
  if (matchedTags.length > 0) {
    parts.push(`tags.ov.{${matchedTags.join(',')}}`);
  }

  return parts.length > 0 ? parts.join(',') : null;
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const job = params.get('job');
  const uploader = params.get('uploader');
  const tags = (params.get('tags') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const q = params.get('q')?.trim() || null;

  if (job && !isUuid(job)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }
  if (uploader && !isUuid(uploader)) {
    return NextResponse.json({ error: 'Invalid uploader id' }, { status: 400 });
  }
  if (!job && !q && !uploader && tags.length === 0) {
    return NextResponse.json(
      { error: 'Provide at least one of job, q, uploader, or tags' },
      { status: 400 }
    );
  }

  const limit = parseLimit(params.get('limit'), PHOTOS_PAGE_SIZE, MAX_LIMIT);
  if (limit === null) {
    return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
  }

  let query = supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .is('deleted_at', null)
    .order('captured_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (job) query = query.eq('job_id', job);
  if (uploader) query = query.eq('uploader_id', uploader);
  for (const tag of tags) query = query.contains('tags', [tag]);

  if (q) {
    let searchFilter: string | null;
    try {
      searchFilter = await buildSearchFilter(supabase, q, job);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Search failed' },
        { status: 500 }
      );
    }
    if (!searchFilter) {
      return NextResponse.json({ success: true, photos: [], nextCursor: null });
    }
    query = query.or(searchFilter);
  }

  const rawCursor = params.get('cursor');
  if (rawCursor) {
    const cursor = decodeKeysetCursor(rawCursor, (capturedAt, id) =>
      isIsoTimestamp(capturedAt) && isUuid(id) ? { capturedAt, id } : null
    );
    if (!cursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    // Separate or() calls are ANDed by PostgREST, so this composes with q.
    query = query.or(
      keysetOrFilter('captured_at', cursor.capturedAt, 'id', cursor.id)
    );
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as PhotoRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit ? encodeKeysetCursor(last.captured_at, last.id) : null;

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
