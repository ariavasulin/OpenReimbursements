// What photo_actor_context (SQL) returns, and the one decision requirePhotoActor
// makes from it. Kept apart from authority.ts (which is server-only) so the
// decision can be unit-tested.

export type PhotoGate = 'photo_writes_enabled' | 'mcp_enabled' | 'repair_enabled';

/** One row of photo_actor_context: the actor's profile, Auth standing, and the release gates. */
export interface PhotoActorContext {
  has_profile: boolean;
  role: string | null;
  profile_deleted: boolean;
  photo_admin: boolean;
  /** photo_require_actor's test: a live profile and an Auth user that is neither deleted nor banned. */
  active: boolean;
  schema_generation: number | null;
  photo_writes_enabled: boolean | null;
  mcp_enabled: boolean | null;
  repair_enabled: boolean | null;
}

/**
 * Why this actor may not go on, or null when they may. The checks run in the
 * order the separate reads used to: the profile (`forbidden`), then the Auth
 * account (`unauthenticated`, as photo_require_actor's invalid_actor maps),
 * then the gates (`temporarily_unavailable`).
 */
export function actorRefusal(
  context: PhotoActorContext | null,
  gates: PhotoGate[],
): 'forbidden' | 'unauthenticated' | 'temporarily_unavailable' | null {
  if (!context || !context.has_profile || context.profile_deleted || !['employee', 'admin'].includes(context.role ?? '')) {
    return 'forbidden';
  }
  if (!context.active) return 'unauthenticated';
  if (!gatesOpen(context, gates)) return 'temporarily_unavailable';
  return null;
}

/** Every named gate is open, on the schema generation this app is built for. */
export function gatesOpen(
  state: Pick<PhotoActorContext, 'schema_generation' | PhotoGate> | null,
  gates: PhotoGate[],
): boolean {
  return !!state && state.schema_generation === 1 && gates.every(gate => state[gate] === true);
}
