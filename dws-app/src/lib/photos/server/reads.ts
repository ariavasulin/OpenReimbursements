import 'server-only';
import { validate as isUuid } from 'uuid';
import { assertPhotoBatchActor, type PhotoActor } from './authority';
import { PhotoApiError, throwPhotoDatabaseError } from './http';

export function photoId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new PhotoApiError('invalid_input');
  return value;
}

/** Intentional ownership read includes retained trash; paths remain server-side. */
export async function readPhotoOwnership(actor: PhotoActor, id: string) {
  const { data, error } = await actor.db.from('photos')
    .select('id,job_id,uploader_id,deleted_at,purge_after,duplicate_of,original_path,thumb_path,preview_path,sidecar_path,playback_path')
    .eq('id', photoId(id)).maybeSingle();
  if (error) throwPhotoDatabaseError(error);
  if (!data) throw new PhotoApiError('not_found');
  return data;
}

/** Employee-readable summary, with mutation authority checked independently by SQL. */
export async function readPhotoBatch(actor: PhotoActor, id: string) {
  const { data, error } = await actor.db.from('migration_batches')
    .select('id,created_by,status,approved_by,approved_at,created_at,updated_at,script_name,origin').eq('id', photoId(id)).maybeSingle();
  if (error) throwPhotoDatabaseError(error);
  if (!data) throw new PhotoApiError('not_found');
  let canMutate = false;
  try {
    await assertPhotoBatchActor(actor, id, 'migration');
    canMutate = true;
  } catch (error) {
    if (!(error instanceof PhotoApiError) || error.code !== 'forbidden') throw error;
  }
  return { batch: data, can_mutate: canMutate };
}
