import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { validate as isUuid } from 'uuid';
import {
  cleanSheet,
  cleanTags,
  escapeForIlike,
  PHOTO_COLUMNS,
} from '@/lib/photos/apiShared';
import {
  CAPTURED_AT_SOURCES,
  PHOTO_KINDS,
  type PhotoRow,
} from '@/lib/photos/types';

// GET  /api/photos?job=&sheet=&tags=&uploader=&q=&cursor=&limit=
//      Filtered photo list, newest capture first, keyset-paginated on
//      (captured_at, id). `q` searches across job number/name, uploader name,
//      and tag membership (ILIKE — no search infrastructure at DWS scale).
// POST /api/photos — finalize an upload: insert the row for files the browser
//      already put in storage. The row existing is what makes a photo "in".

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function encodeCursor(capturedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([capturedAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): { capturedAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      isUuid(parsed[1])
    ) {
      return { capturedAt: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Resolve a free-text query into a PostgREST or() filter over photos:
 * matching job ids, matching uploader ids, and overlapping tags.
 * Returns null when nothing matches (the result set is empty).
 */
async function buildSearchFilter(
  supabase: ServerClient,
  q: string
): Promise<string | null> {
  const escaped = escapeForIlike(q);
  if (!escaped) return null;
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
    supabase.from('photos').select('tags').limit(10000),
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

  const query = q.toLowerCase();
  const matchedTags = new Set<string>();
  for (const row of tagRowsResult.data ?? []) {
    for (const tag of row.tags) {
      if (tag.toLowerCase().includes(query)) {
        // Tags with or()/array syntax characters can't be embedded safely;
        // the UI never produces them, so skipping is the safe trade.
        if (!/[,(){}"\\]/.test(tag)) matchedTags.add(tag);
      }
    }
  }
  if (matchedTags.size > 0) {
    parts.push(`tags.ov.{${[...matchedTags].join(',')}}`);
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
  const sheet = params.get('sheet')?.trim() || null;
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

  const limit = Math.min(
    Math.max(parseInt(params.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  let query = supabase
    .from('photos')
    .select(PHOTO_COLUMNS)
    .order('captured_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (job) query = query.eq('job_id', job);
  if (uploader) query = query.eq('uploader_id', uploader);
  if (sheet) query = query.eq('sheet_number', sheet);
  for (const tag of tags) query = query.contains('tags', [tag]);

  if (q) {
    let searchFilter: string | null;
    try {
      searchFilter = await buildSearchFilter(supabase, q);
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
    const cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    // Separate or() calls are ANDed by PostgREST, so this composes with q.
    query = query.or(
      `captured_at.lt.${cursor.capturedAt},and(captured_at.eq.${cursor.capturedAt},id.lt.${cursor.id})`
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
    rows.length > limit ? encodeCursor(last.captured_at, last.id) : null;

  return NextResponse.json({ success: true, photos: page, nextCursor });
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    id,
    job_id,
    kind,
    sheet_number,
    tags,
    captured_at,
    captured_at_source,
    original_path,
    original_bytes,
    mime_type,
    original_name,
    thumb_path,
    preview_path,
    duration_secs,
  } = body;

  if (typeof id !== 'string' || !isUuid(id)) {
    return NextResponse.json({ error: 'Invalid photo id' }, { status: 400 });
  }
  if (typeof job_id !== 'string' || !isUuid(job_id)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }
  if (typeof kind !== 'string' || !(PHOTO_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: 'Invalid kind' }, { status: 400 });
  }

  // Storage RLS already limits writes to the caller's own prefix; the row
  // must point inside that same prefix so nobody claims another user's file.
  const ownPrefix = `originals/${userId}/`;
  if (typeof original_path !== 'string' || !original_path.startsWith(ownPrefix)) {
    return NextResponse.json(
      { error: 'original_path must be under your own prefix' },
      { status: 400 }
    );
  }
  const ownDerivedPrefix = `derived/${userId}/`;
  for (const derivedPath of [thumb_path, preview_path]) {
    if (
      derivedPath != null &&
      (typeof derivedPath !== 'string' || !derivedPath.startsWith(ownDerivedPrefix))
    ) {
      return NextResponse.json(
        { error: 'Derivative paths must be under your own prefix' },
        { status: 400 }
      );
    }
  }

  const capturedAtDate =
    typeof captured_at === 'string' && !Number.isNaN(Date.parse(captured_at))
      ? new Date(captured_at)
      : null;

  const { data: photo, error } = await supabase
    .from('photos')
    .insert({
      id,
      job_id,
      uploader_id: userId, // never trusted from the client
      kind,
      sheet_number: cleanSheet(sheet_number),
      tags: cleanTags(tags),
      // EXIF capture time when the client found one; upload time as fallback.
      captured_at: (capturedAtDate ?? new Date()).toISOString(),
      // Provenance is only trusted alongside a real date; old clients that
      // omit it (and the now() fallback) land as 'upload'.
      captured_at_source:
        typeof captured_at_source === 'string' &&
        (CAPTURED_AT_SOURCES as readonly string[]).includes(captured_at_source) &&
        capturedAtDate
          ? captured_at_source
          : 'upload',
      original_path,
      original_bytes:
        typeof original_bytes === 'number' && Number.isFinite(original_bytes)
          ? Math.max(0, Math.round(original_bytes))
          : null,
      mime_type: typeof mime_type === 'string' && mime_type ? mime_type : null,
      original_name:
        typeof original_name === 'string' && original_name ? original_name : null,
      thumb_path: thumb_path ?? null,
      preview_path: preview_path ?? null,
      duration_secs:
        typeof duration_secs === 'number' && Number.isFinite(duration_secs)
          ? duration_secs
          : null,
    })
    .select(PHOTO_COLUMNS)
    .single();

  if (error) {
    // 23505 = the row already exists (a retry of a finalize that actually
    // landed); treat as success so retries converge.
    if (error.code === '23505') {
      return NextResponse.json({ success: true, alreadyExists: true });
    }
    const status = error.code === '23503' ? 400 : 500; // bad FK vs. real failure
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ success: true, photo }, { status: 201 });
}
