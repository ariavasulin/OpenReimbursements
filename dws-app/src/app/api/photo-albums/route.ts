import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import { mapAlbumSummary } from '@/lib/photos/albumSummary';
import type { PhotoAlbumSummaryRow } from '@/lib/photos/types';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { requirePhotoReader } from '@/lib/photos/server/reads';

const RESTORE_DAYS = 30;
/** Deleted albums shown at once. Far above what 30 days of deleting produces by hand. */
const MAX_DELETED_ALBUMS = 500;

// GET /api/photo-albums?q= — album cards: name, active-photo count, up to 4
//     newest thumbnails. Most recently added-to first. Mirrors GET /api/photo-jobs.
// GET /api/photo-albums?deleted=1 — albums deleted in the last 30 days, newest
//     deletion first, for the Trash page. Employees cannot read deleted albums
//     through their own session, so this one goes through the verified actor.
export async function GET(request: Request) {
  return photoRoute(async () => {
    const params = new URL(request.url).searchParams;
    if (params.has('deleted')) {
      if (params.get('deleted') !== '1') throw new PhotoApiError('invalid_input');
      const actor = await requirePhotoActor(request);
      const since = new Date(Date.now() - RESTORE_DAYS * 86_400_000).toISOString();
      const { data, error } = await actor.db.from('albums').select('id,name,deleted_at,deleted_by')
        .gt('deleted_at', since).order('deleted_at', { ascending: false }).order('id').limit(MAX_DELETED_ALBUMS);
      if (error) throwPhotoDatabaseError(error);
      return photoJson({ success: true, albums: (data ?? []).map(album => ({ ...album,
        restore_before: new Date(Date.parse(album.deleted_at) + RESTORE_DAYS * 86_400_000).toISOString() })) });
    }
    const session = await requirePhotoReader();
    const q = escapeIlikeWildcards(params.get('q')?.trim() ?? '');
    const { data, error } = await session.rpc('get_photo_album_summaries', { q: q || null });
    if (error) throwPhotoDatabaseError(error);
    return photoJson({ success: true, albums: ((data ?? []) as PhotoAlbumSummaryRow[]).map(mapAlbumSummary) });
  });
}

// POST /api/photo-albums { name } — create an album. Names need not be unique.
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request);
    if (typeof body.name !== 'string') throw new PhotoApiError('invalid_input');
    return photoJson(await photoRpc(actor, 'photo_create_album', { p_actor: actor.actorId, p_name: body.name }), 201);
  });
}
