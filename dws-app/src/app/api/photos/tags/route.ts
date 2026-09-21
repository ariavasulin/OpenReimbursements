import { requirePhotoActor } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson } from '@/lib/photos/server/http';
import { BULK_BODY_BYTES, bulkPhotoIds } from '@/lib/photos/server/reads';

/** Absent means none. Length, count, and blank checks are SQL's, so nothing is trimmed or cut silently here. */
function tagList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) throw new PhotoApiError('invalid_input');
  return value;
}

// POST /api/photos/tags { photo_ids: [1-500 ids], add?: string[], remove?: string[] }
// Bulk tagging. Returns { updated, skipped, missing }:
//   updated — active photos that now hold the requested tags (a repeat counts too);
//   skipped — photos the change would push past 20 tags; they are left untouched;
//   missing — ids that are trashed or unknown.
// A tag that matches an existing one ignoring case is stored with the existing
// spelling ("Kitchen" becomes "kitchen"); removing ignores case too.
export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const body = await readPhotoJson(request, BULK_BODY_BYTES);
    onlyKeys(body, ['photo_ids', 'add', 'remove']);
    return photoJson(await photoRpc(actor, 'photo_bulk_tag', {
      p_actor: actor.actorId, p_photo_ids: bulkPhotoIds(body.photo_ids), p_add: tagList(body.add), p_remove: tagList(body.remove),
    }));
  });
}
