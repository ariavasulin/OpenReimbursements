import type { CapturedAtSource, PhotoKind } from './types';

export interface UploadOwner { owner_kind: 'ordinary' | 'migration'; owner_id: string }
export interface CanonicalUploadOutcome {
  status: 'created' | 'duplicate_active' | 'duplicate_trashed';
  photo_id: string;
  /** The photo's project; null when it has none (uploaded into an album only). */
  job_id: string | null;
  purge_after?: string | null;
  warnings?: string[];
  cleanup_pending?: boolean;
  sidecar_retry?: boolean;
  sidecar_attached?: boolean;
  new_attempt_required?: boolean;
  can_restore?: boolean;
  remedy?: string;
}
/** Every upload names a project, an album, or both; naming neither is refused. */
export interface CreateUploadAttemptInput {
  attempt_id: string; photo_id: string; job_id: string | null; album_ids?: string[];
  source_signature: string; content_sha256: string;
  original_name: string; original_bytes: number; mime_type: string;
}
/** Full identity lets cancellation settle a lost attempt-creation response. */
export interface CancelUploadInput extends CreateUploadAttemptInput { owner_kind: 'ordinary' }
export type CancelUploadOutcome = { status: 'cancelled' } | CanonicalUploadOutcome;
export interface UploadAttempt extends UploadOwner {
  photo_id: string; job_id: string | null; content_sha256: string;
  original_path: string; thumb_path: string; preview_path: string; sidecar_path: string;
  result: CanonicalUploadOutcome | null;
}
/**
 * POST /api/photo-migrations/uploads/begin: attempt, lease, claim and (on a
 * retry) the original-file check in one request, in the same order the
 * separate routes run them. Ordinary uploads only; the importer keeps its own
 * prepare step.
 */
export interface BeginUploadInput extends CreateUploadAttemptInput {
  /** Check for an original a lost response may have left. False for a fresh identity: nothing can be there yet. */
  probe: boolean;
  /** The lease an earlier try of this attempt took and could not hand back,
   *  because its release went down with the connection. Begin releases it
   *  first, so this try need not wait out the two-minute lease. */
  release_generation?: number;
}
/** Each step is present only if the one before it let the upload go on. */
export interface BeginUploadOutcome {
  attempt: UploadAttempt;
  acquired?: AcquireUploadOutcome;
  claimed?: ClaimUploadOutcome;
  /** Null when the check was not asked for. */
  original?: OriginalUploadState | null;
  /** The stored original differs from this file: start a fresh attempt. */
  original_mismatch?: true;
  /** Another try of this attempt still holds its lease (one whose release was
   *  lost, or whose begin answer never arrived). Try again after this many
   *  milliseconds, when the lease has run out. A field of its own, not an
   *  `acquired` status, so a page loaded before this answer existed falls
   *  back to the separate acquire route as it always did. */
  lease_busy?: { retry_after_ms: number };
}
export interface UploadLease {
  status: 'acquired'; lease_generation: number; lease_expires_at: string;
}
export interface UploadLeaseInput extends UploadOwner { lease_generation: number }
export interface UploadClaimInput extends UploadLeaseInput { claim_generation: number }
export interface OriginalUploadState { complete: boolean }
export type AcquireUploadOutcome = UploadLease | CanonicalUploadOutcome;
export type ClaimUploadOutcome = CanonicalUploadOutcome |
  { status: 'claimed'; claim_generation: number; lease_expires_at: string } |
  { status: 'waiting_claim'; lease_expires_at: string };
export interface ReleaseUploadInput extends UploadLeaseInput {
  status: 'retryable_failed' | 'cancelled'; error_code?: string;
}
export interface AttachUploadSidecarInput extends UploadOwner {
  sidecar_name: string; sidecar_bytes: number;
}
export interface FinalizeUploadInput extends UploadClaimInput {
  id: string; job_id: string | null; kind: PhotoKind;
  tags: string[];
  captured_at: string | null; captured_at_source: CapturedAtSource;
  original_path: string; original_bytes: number; mime_type: string | null;
  original_name: string; thumb_path: string | null; preview_path: string | null;
  duration_secs: number | null; sidecar_path: string | null; sidecar_name: string | null;
  content_sha256: string; warnings: string[];
}
/** Two capture times this close are the same shot (GET /api/photos/twin). */
export const FORMAT_TWIN_WINDOW_MS = 1_000;
/** GET /api/photos/twin: the same shot already in the project in another format. */
export interface FormatTwin {
  id: string; job_id: string; original_name: string;
  display_name: string | null; captured_at: string;
}
export interface FormatTwinQuery {
  job_id: string; base: string; captured_at: string; content_sha256: string;
}
