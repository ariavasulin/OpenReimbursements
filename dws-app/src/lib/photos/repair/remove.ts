import type { SupabaseClient } from '@supabase/supabase-js';

/** A completed HTTP delete may contain only a subset of requested names (or
 * no names for already absent objects). Never treat its data array as proof:
 * verify this exact object is absent using Storage HEAD before dropping a row. */
export async function removeConfirmed(admin: SupabaseClient, objectPath: string) {
  const removed = await admin.storage.from('photos').remove([objectPath]);
  if (removed.error) throw new Error(`remove ${objectPath}: ${removed.error.message}`);
  if ((await admin.storage.from('photos').exists(objectPath)).data) {
    throw new Error(`remove ${objectPath}: object remains after delete`);
  }
}
