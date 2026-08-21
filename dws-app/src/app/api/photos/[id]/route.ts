import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import { validate as isUuid } from 'uuid';
import { cleanSheet, cleanTags, PHOTO_COLUMNS } from '@/lib/photos/apiShared';

// PATCH  /api/photos/:id — fix organizational metadata (job / sheet / tags).
//        Any signed-in user. The editable columns are whitelisted here; RLS
//        allows the update itself.
// DELETE /api/photos/:id — uploader or admin only (photos are evidence).
//        Enforced by RLS (photos_delete: uploader_id = auth.uid() or
//        is_admin()); the route reports 403 when RLS deleted nothing.

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Invalid photo id' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if ('job_id' in body) {
    if (typeof body.job_id !== 'string' || !isUuid(body.job_id)) {
      return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
    }
    updates.job_id = body.job_id;
  }

  if ('sheet_number' in body) {
    const sheet = body.sheet_number;
    if (sheet !== null && typeof sheet !== 'string') {
      return NextResponse.json(
        { error: 'sheet_number must be a string or null' },
        { status: 400 }
      );
    }
    updates.sheet_number = cleanSheet(sheet);
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags)) {
      return NextResponse.json(
        { error: 'tags must be an array of strings' },
        { status: 400 }
      );
    }
    updates.tags = cleanTags(body.tags);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'Nothing to update — provide job_id, sheet_number, or tags' },
      { status: 400 }
    );
  }

  const { data: photo, error } = await supabase
    .from('photos')
    .update(updates)
    .eq('id', id)
    .select(PHOTO_COLUMNS)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
    }
    const status = error.code === '23503' ? 400 : 500; // bad job FK vs. real failure
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ success: true, photo });
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Invalid photo id' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Grab the storage paths before the row disappears (SELECT is open to all
  // signed-in users, so this also distinguishes 404 from 403).
  const { data: existing, error: fetchError } = await supabase
    .from('photos')
    .select('id, original_path, thumb_path, preview_path')
    .eq('id', id)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 });
  }

  // RLS decides: only the uploader or an admin actually deletes anything.
  const { data: deleted, error: deleteError } = await supabase
    .from('photos')
    .delete()
    .eq('id', id)
    .select('id');
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }
  if (!deleted || deleted.length === 0) {
    return NextResponse.json(
      { error: 'Only the uploader or an admin can delete a photo' },
      { status: 403 }
    );
  }

  // Best-effort storage cleanup (service role — users have no storage DELETE
  // policy). Leftovers on failure are exactly the orphans the repair cron
  // sweeps, so errors here never fail the request.
  const paths = [
    existing.original_path,
    existing.thumb_path,
    existing.preview_path,
  ].filter((path): path is string => Boolean(path));
  if (paths.length > 0) {
    await supabaseAdmin.storage.from('photos').remove(paths);
  }

  return NextResponse.json({ success: true });
}
