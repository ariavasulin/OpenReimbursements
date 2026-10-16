import 'server-only';
import type { PhotoAction } from '../action-types';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { PhotoApiError, requireSameOrigin, throwPhotoDatabaseError } from './http';
import { actorRefusal, type PhotoActorContext } from './actor-context';

const verifiedActor = Symbol('verified photo actor');
export interface PhotoActor {
  readonly [verifiedActor]: true;
  readonly actorId: string;
  /** user_profiles.photo_admin, read on every request so a change is live at once. */
  readonly isPhotoAdmin: boolean;
  readonly session: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  readonly db: typeof import('@/lib/supabaseAdminClient').supabaseAdmin;
}

export type { PhotoGate } from './actor-context';

/**
 * Auth verifies cookies remotely before service credentials are loaded or used.
 * Then ONE read (photo_actor_context) returns the profile, the Auth account's
 * standing, and the release gates, where there used to be three reads back to
 * back: two round trips per check instead of four, and an upload makes several
 * checks per photo. The refusals, and their order, are those of the separate reads.
 */
export async function requirePhotoActor(
  request: Request,
  options: { mutation?: boolean; mcp?: boolean } = {},
): Promise<PhotoActor> {
  if (options.mutation) requireSameOrigin(request);
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user || data.user.is_anonymous) throw new PhotoApiError('unauthenticated');
  const { supabaseAdmin: db } = await import('@/lib/supabaseAdminClient');
  const context = await db.rpc('photo_actor_context', { p_actor: data.user.id });
  if (context.error) throwPhotoDatabaseError(context.error);
  const facts = context.data as PhotoActorContext | null;
  // Also fences a still-valid cookie after an Auth ban or account deactivation.
  const refusal = actorRefusal(facts, options.mcp ? ['photo_writes_enabled', 'mcp_enabled'] : ['photo_writes_enabled']);
  if (refusal) throw new PhotoApiError(refusal);
  return { [verifiedActor]: true, actorId: data.user.id, isPhotoAdmin: facts!.photo_admin === true, session, db };
}

/** Delete forever, Empty trash, project Delete. SQL checks the same flag; this saves the round trip. */
export function requirePhotoAdmin(actor: PhotoActor): void {
  if (!actor.isPhotoAdmin) throw new PhotoApiError('forbidden');
}

/** Later mutations must call this with the route's action, never a client-selected permission. */
export async function assertPhotoBatchActor(
  actor: PhotoActor, batchId: string, kind: 'migration' | 'action', action?: PhotoAction,
): Promise<void> {
  const { error } = await actor.db.rpc('photo_assert_batch_actor', {
    p_actor: actor.actorId, p_batch_id: batchId, p_kind: kind, p_action: action ?? null,
  });
  if (error) throwPhotoDatabaseError(error);
}
