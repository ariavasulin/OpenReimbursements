import 'server-only';
import { validate as isUuid } from 'uuid';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { MAX_BULK_PHOTOS } from '../apiShared';
import { assertPhotoBatchActor, type PhotoActor } from './authority';
import { PhotoApiError, throwPhotoDatabaseError } from './http';

export function photoId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new PhotoApiError('invalid_input');
  return value;
}

/** 500 UUIDs are about 20 KB of JSON, over the 16 KB default body limit. */
export const BULK_BODY_BYTES = 64 * 1024;

/** 1-500 photo ids, counted as sent. SQL applies the same limits; this saves the round trip. */
export function bulkPhotoIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BULK_PHOTOS) throw new PhotoApiError('invalid_input');
  return value.map(photoId);
}

/**
 * A signed-in library read through the employee's own session, like GET /api/photos:
 * the row rules decide what is visible (active photos, live albums), and the
 * writes gate is not consulted, so browsing still works while writes are closed.
 */
export async function requirePhotoReader() {
  const session = await createSupabaseServerClient();
  const { data } = await session.auth.getSession();
  if (!data.session) throw new PhotoApiError('unauthenticated');
  return session;
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
