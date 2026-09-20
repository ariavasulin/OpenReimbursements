import { createHash } from 'node:crypto';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, PhotoApiError, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';

const photoScripts = new Set(['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos']);

export async function POST(request: Request) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true, mcp: true });
    const body = await readPhotoJson(request);
    // A 32-byte random token encoded as unpadded base64url, independent of the MCP URL key.
    if (Object.keys(body).some(key => key !== 'token' && key !== 'script_name') ||
        typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token) ||
        typeof body.script_name !== 'string' || !photoScripts.has(body.script_name)) {
      throw new PhotoApiError('invalid_input');
    }
    const { data, error } = await actor.db.rpc('consume_dws_handoff', {
      p_token_digest: createHash('sha256').update(body.token).digest('hex'),
      p_actor: actor.actorId,
      p_script: body.script_name,
    });
    if (error) throwPhotoDatabaseError(error);
    // Never return the ledger's requested input, digest, or consumed token.
    return photoJson({
      migration_batch_id: data.migration_batch_id,
      photo_action_batch_id: data.photo_action_batch_id,
      script_name: data.script_name,
    });
  });
}
