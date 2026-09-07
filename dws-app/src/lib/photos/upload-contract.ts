import type { CapturedAtSource, PhotoKind } from './types';

export interface UploadOwner { owner_kind: 'ordinary' | 'migration'; owner_id: string }
export interface CanonicalUploadOutcome {
  status: 'created' | 'duplicate_active' | 'duplicate_trashed';
  photo_id: string;
  job_id: string;
  purge_after?: string | null;
  warnings?: string[];
  cleanup_pending?: boolean;
  sidecar_retry?: boolean;
  sidecar_attached?: boolean;
  new_attempt_required?: boolean;
  can_restore?: boolean;
  remedy?: string;
}
export interface CreateUploadAttemptInput {
  attempt_id: string; photo_id: string; job_id: string;
  source_signature: string; content_sha256: string;
  original_name: string; original_bytes: number; mime_type: string;
}
/** Full identity lets cancellation settle a lost attempt-creation response. */
export interface CancelUploadInput extends CreateUploadAttemptInput { owner_kind: 'ordinary' }
export type CancelUploadOutcome = { status: 'cancelled' } | CanonicalUploadOutcome;
export interface UploadAttempt extends UploadOwner {
  photo_id: string; job_id: string; content_sha256: string;
  original_path: string; thumb_path: string; preview_path: string; sidecar_path: string;
  result: CanonicalUploadOutcome | null;
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
  id: string; job_id: string; kind: PhotoKind;
  sheet_number: string | null; tags: string[];
  captured_at: string | null; captured_at_source: CapturedAtSource;
  original_path: string; original_bytes: number; mime_type: string | null;
  original_name: string; thumb_path: string | null; preview_path: string | null;
  duration_secs: number | null; sidecar_path: string | null; sidecar_name: string | null;
  content_sha256: string; warnings: string[];
}
