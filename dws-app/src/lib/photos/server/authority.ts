import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { PhotoApiError, requireSameOrigin, throwPhotoDatabaseError } from './http';

const verifiedActor = Symbol('verified photo actor');
export interface PhotoActor {
  readonly [verifiedActor]: true;
  readonly actorId: string;
  readonly session: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  readonly db: typeof import('@/lib/supabaseAdminClient').supabaseAdmin;
}

export type PhotoGate = 'photo_writes_enabled' | 'mcp_enabled' | 'repair_enabled';

/** Auth verifies cookies remotely before service credentials are loaded or used. */
export async function requirePhotoActor(
  request: Request,
  options: { mutation?: boolean; mcp?: boolean } = {},
): Promise<PhotoActor> {
  if (options.mutation) requireSameOrigin(request);
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user || data.user.is_anonymous) throw new PhotoApiError('unauthenticated');
  const profile = await session.from('user_profiles').select('role,deleted_at')
    .eq('user_id', data.user.id).maybeSingle();
  if (profile.error) throwPhotoDatabaseError(profile.error);
  if (!profile.data || profile.data.deleted_at || !['employee', 'admin'].includes(profile.data.role)) {
    throw new PhotoApiError('forbidden');
  }
  const { supabaseAdmin: db } = await import('@/lib/supabaseAdminClient');
  const actor: PhotoActor = { [verifiedActor]: true, actorId: data.user.id, session, db };
  // Also fences a still-valid cookie after an Auth ban or account deactivation.
  const activeActor = await db.rpc('photo_require_actor', { p_actor: actor.actorId });
  if (activeActor.error) throwPhotoDatabaseError(activeActor.error);
  await requirePhotoGates(actor, options.mcp ? ['photo_writes_enabled', 'mcp_enabled'] : ['photo_writes_enabled']);
  return actor;
}

export async function requirePhotoGates(actor: PhotoActor, gates: PhotoGate[]): Promise<void> {
  const { data, error } = await actor.db.from('photo_release_state')
    .select('schema_generation,photo_writes_enabled,mcp_enabled,repair_enabled')
    .eq('singleton', true).maybeSingle();
  if (error || !data || data.schema_generation !== 1 || gates.some(gate => data[gate] !== true)) {
    throw new PhotoApiError('temporarily_unavailable');
  }
}

export async function isPhotoAdministrator(actor: PhotoActor): Promise<boolean> {
  const { data, error } = await actor.session.rpc('is_admin');
  if (error) throwPhotoDatabaseError(error);
  return data === true;
}

/** Later mutations must call this with the route's action, never a client-selected permission. */
export async function assertPhotoBatchActor(
  actor: PhotoActor, batchId: string, kind: 'migration' | 'action', action?: 'move' | 'trash' | 'restore',
): Promise<void> {
  const { error } = await actor.db.rpc('photo_assert_batch_actor', {
    p_actor: actor.actorId, p_batch_id: batchId, p_kind: kind, p_action: action ?? null,
  });
  if (error) throwPhotoDatabaseError(error);
}
