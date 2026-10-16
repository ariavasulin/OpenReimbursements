import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { bulkActionInput, RUN_BODY_BYTES, runBulkAction } from '@/lib/photos/server/bulk';

// POST /api/photos/bulk {action: 'trash'|'restore', photo_ids}
//      Trash (or restore) up to MAX_ACTION_RUN_PHOTOS photos in one request:
//      { batch_id, photo_ids (reached), left_out, failed }. A photo that is gone,
//      or that this person may not trash, is left out and counted rather than
//      failing the request. lib/photos/server/bulk.ts runs the batch.

/** About 25 SQL calls for 1,000 photos; a minute leaves wide headroom. */
export const maxDuration = 60;

export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const { action, ids } = bulkActionInput(await readPhotoJson(request, RUN_BODY_BYTES));
    return photoJson(await runBulkAction(actor, action, ids));
  });
}
