import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { PhotoRow } from '@/lib/photos/types';

// GET  /api/photos?job=&cursor=&limit= — photos for one job, newest capture
//      first, keyset-paginated on (captured_at, id).
// POST /api/photos — finalize an upload: insert the row for files the browser
//      already put in storage. The row existing is what makes a photo "in".

const PHOTO_COLUMNS =
  'id, job_id, kind, sheet_number, tags, captured_at, original_path, ' +
  'original_bytes, mime_type, original_name, thumb_path, preview_path, ' +
  'duration_secs, created_at, uploader:user_profiles(full_name)';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      UUID_RE.test(parsed[1])
    ) {
      return { capturedAt: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
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
  if (!job || !UUID_RE.test(job)) {
    return NextResponse.json(
      { error: 'A valid job id is required' },
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
    .eq('job_id', job)
    .order('captured_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  const rawCursor = params.get('cursor');
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
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
    rows.length > limit && last ? encodeCursor(last.captured_at, last.id) : null;

  return NextResponse.json({ success: true, photos: page, nextCursor });
}

const KINDS = new Set(['image', 'video', 'file']);
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;

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
    original_path,
    original_bytes,
    mime_type,
    original_name,
    thumb_path,
    preview_path,
    duration_secs,
  } = body;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid photo id' }, { status: 400 });
  }
  if (typeof job_id !== 'string' || !UUID_RE.test(job_id)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
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

  const cleanTags = Array.isArray(tags)
    ? [
        ...new Set(
          tags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
            .filter(Boolean)
        ),
      ].slice(0, MAX_TAGS)
    : [];

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
      sheet_number:
        typeof sheet_number === 'string' && sheet_number.trim()
          ? sheet_number.trim()
          : null,
      tags: cleanTags,
      // EXIF capture time when the client found one; upload time as fallback.
      captured_at: (capturedAtDate ?? new Date()).toISOString(),
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
