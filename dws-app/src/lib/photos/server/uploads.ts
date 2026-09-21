import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { cleanTags, isSha256 } from '../apiShared';
import { CAPTURED_AT_SOURCES, PHOTO_KINDS } from '../types';
import type { CanonicalUploadOutcome, UploadOwner, UploadAttempt, OriginalUploadState } from '../upload-contract';
import type { PhotoActor } from './authority';
import { photoId } from './reads';
import { PhotoApiError, throwPhotoDatabaseError, photoRpc } from './http';

type Body = Record<string, unknown>;
export function uploadOwner(body: Body): UploadOwner {
  if (body.owner_kind !== 'ordinary' && body.owner_kind !== 'migration') throw new PhotoApiError('invalid_input');
  return { owner_kind: body.owner_kind, owner_id: photoId(body.owner_id) };
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new PhotoApiError('invalid_input');
  return value;
}
function string(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new PhotoApiError('invalid_input');
  return value;
}
function digest(value: unknown): string {
  if (!isSha256(value)) throw new PhotoApiError('invalid_input');
  return value as string;
}
export function uploadRpcArgs(actor: PhotoActor, body: Body, generation = false, claim = false) {
  const owner = uploadOwner(body);
  return { p_actor: actor.actorId, p_owner_kind: owner.owner_kind, p_owner_id: owner.owner_id,
    ...(generation ? { p_generation: integer(body.lease_generation, 1) } : {}),
    ...(claim ? { p_claim_generation: integer(body.claim_generation, 1) } : {}) };
}

export async function describeUploadOutcome(actor: PhotoActor, outcome: CanonicalUploadOutcome): Promise<CanonicalUploadOutcome> {
  if (outcome.status !== 'duplicate_trashed') return outcome;
  const { data, error } = await actor.db.from('photos').select('purge_after').eq('id', outcome.photo_id).maybeSingle();
  if (error) throwPhotoDatabaseError(error);
  // Any signed-in employee may restore; only retention can still prevent it.
  const expired = !data || !data.purge_after || Date.parse(data.purge_after) <= Date.now();
  return { ...outcome, can_restore: !expired,
    remedy: expired ? 'This photo is awaiting permanent cleanup. Retry after cleanup completes.' : 'Confirm restoration before uploading.' };
}

export async function createUploadAttempt(actor: PhotoActor, body: Body): Promise<UploadAttempt> {
  const name = string(body.original_name);
  if (/[/\\]/.test(name)) throw new PhotoApiError('invalid_input');
  const value = await photoRpc(actor, 'photo_create_upload_attempt', {
    p_actor: actor.actorId, p_job_id: photoId(body.job_id), p_attempt_id: photoId(body.attempt_id),
    p_photo_id: photoId(body.photo_id), p_source_signature: string(body.source_signature, 2048),
    p_digest: digest(body.content_sha256), p_original_name: name,
    p_original_bytes: integer(body.original_bytes), p_mime_type: string(body.mime_type, 255),
  });
  return { owner_kind: 'ordinary', owner_id: value.id, photo_id: value.photo_id, job_id: value.job_id,
    content_sha256: value.content_sha256, original_path: value.original_path, thumb_path: value.thumb_path,
    preview_path: value.preview_path, sidecar_path: value.sidecar_path,
    result: value.result ? await describeAttemptResult(actor, value) : null };
}

export async function describeAttemptResult(actor: PhotoActor, bound: {
  result: CanonicalUploadOutcome; warnings: string[]; new_attempt_required?: boolean;
  job_id: string; original_path: string; sidecar_path: string; content_sha256: string;
}): Promise<CanonicalUploadOutcome> {
  const result = { ...bound.result, warnings: bound.warnings, ...(bound.new_attempt_required ? { new_attempt_required: true } : {}) };
  if (result.status === 'created') {
    const { data, error } = await actor.db.from('photos').select('uploader_id,job_id,original_path,content_sha256,deleted_at,sidecar_path')
      .eq('id', result.photo_id).maybeSingle();
    if (error) throwPhotoDatabaseError(error);
    const current = !!data && data.uploader_id === actor.actorId && data.job_id === bound.job_id &&
      data.original_path === bound.original_path && data.content_sha256 === bound.content_sha256 && !data.deleted_at;
    result.sidecar_attached = current && !!bound.sidecar_path && data!.sidecar_path === bound.sidecar_path && bound.sidecar_path !== bound.original_path;
    result.sidecar_retry = current && !!bound.sidecar_path && !data!.sidecar_path && bound.sidecar_path !== bound.original_path &&
      bound.warnings.some(warning => ['sidecar_missing', 'sidecar_failed'].includes(warning) || warning.startsWith('Sidecar upload failed.') || /^Sidecar .+ was not reselected;/.test(warning));
  }
  return describeUploadOutcome(actor, result);
}

/** Read metadata through Storage, independently of SQL's storage.objects check. */
async function objectSize(actor: PhotoActor, path: string): Promise<number | null> {
  const { data, error } = await actor.db.storage.from('photos').info(path);
  if (error || !data) return null;
  const size = data.size;
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** This runs only after the finalize RPC response proves its transaction committed. */
async function cleanupDuplicate(actor: PhotoActor, owner: UploadOwner): Promise<boolean> {
  try {
    // Fresh reference checks are authoritative; never accept client-supplied deletion paths.
    const paths = await photoRpc(actor, 'photo_upload_cleanup_paths', {
      p_actor: actor.actorId, p_owner_kind: owner.owner_kind, p_owner_id: owner.owner_id,
    });
    if (!Array.isArray(paths) || paths.length === 0) return false;
    const { error } = await actor.db.storage.from('photos').remove(paths);
    return !!error;
  } catch {
    // The canonical result already committed. Repair owns eventual orphan cleanup.
    return true;
  }
}

export async function finalizeUpload(actor: PhotoActor, body: Body): Promise<CanonicalUploadOutcome> {
  const args = uploadRpcArgs(actor, body, true, true);
  const owner = uploadOwner(body);
  const bound = await photoRpc(actor, 'photo_lock_upload', uploadRpcArgs(actor, body));
  if (photoId(body.id) !== bound.photo_id || photoId(body.job_id) !== bound.job_id ||
      digest(body.content_sha256) !== bound.content_sha256 || body.original_path !== bound.original_path ||
      integer(body.original_bytes) !== Number(bound.original_bytes) || body.original_name !== bound.original_name || body.mime_type !== bound.mime_type) {
    throw new PhotoApiError('conflict');
  }
  if (!PHOTO_KINDS.includes(body.kind as never) || !CAPTURED_AT_SOURCES.includes(body.captured_at_source as never)) throw new PhotoApiError('invalid_input');
  if (body.captured_at !== null && (typeof body.captured_at !== 'string' || !Number.isFinite(Date.parse(body.captured_at)))) throw new PhotoApiError('invalid_input');
  if (!Array.isArray(body.warnings) || body.warnings.length > 32 || body.warnings.some(w => typeof w !== 'string' || w.length > 256)) throw new PhotoApiError('invalid_input');
  if (body.duration_secs !== null && (typeof body.duration_secs !== 'number' || !Number.isFinite(body.duration_secs) || body.duration_secs < 0)) throw new PhotoApiError('invalid_input');
  for (const field of ['thumb_path', 'preview_path', 'sidecar_path']) {
    if (body[field] !== null && body[field] !== bound[field]) throw new PhotoApiError('invalid_input');
  }
  if (body.sidecar_name !== null) string(body.sidecar_name);
  // Persist the normalized request alongside the effective paths, so lost-response
  // replay does not depend on objects that duplicate cleanup already removed.
  const requested = { kind: body.kind, tags: cleanTags(body.tags),
    captured_at: body.captured_at, captured_at_source: body.captured_at_source,
    thumb_path: body.thumb_path, preview_path: body.preview_path, sidecar_path: body.sidecar_path,
    sidecar_name: body.sidecar_name, duration_secs: body.duration_secs, warnings: [...new Set(body.warnings)] };
  let outcome: CanonicalUploadOutcome;
  let warnings: string[];
  if (bound.result) {
    if (!isDeepStrictEqual(bound.finalize_payload?.request, requested)) throw new PhotoApiError('conflict');
    // SQL independently checks exact committed-payload replay and owner authority.
    outcome = await photoRpc(actor, 'photo_finalize_upload', { ...args, p_photo: bound.finalize_payload });
    warnings = bound.warnings;
  } else {
    if (await objectSize(actor, bound.original_path) !== Number(bound.original_bytes)) throw new PhotoApiError('conflict');
    const photo = { ...requested, request: requested, warnings: [...requested.warnings] as string[] };
    const fields = ['thumb_path', 'preview_path', 'sidecar_path'] as const;
    const sizes = await Promise.allSettled(fields.map(field => photo[field] === null ? null : objectSize(actor, photo[field] as string)));
    for (const [index, field] of fields.entries()) {
      const size = sizes[index];
      if (size.status === 'rejected') throw size.reason;
      if (photo[field] !== null && size.value === null) {
        photo[field] = null;
        photo.warnings.push(field === 'sidecar_path' ? 'Sidecar upload failed. Reselect the sidecar to retry.' :
          field === 'thumb_path' ? 'Thumbnail upload failed; the original is preserved.' : 'Preview upload failed; the original is preserved.');
        if (field === 'sidecar_path') photo.sidecar_name = null;
      }
    }
    photo.warnings = [...new Set(photo.warnings)];
    outcome = await photoRpc(actor, 'photo_finalize_upload', { ...args, p_photo: photo });
    warnings = photo.warnings;
  }
  const cleanupPending = outcome.status !== 'created' ? await cleanupDuplicate(actor, owner) : false;
  return describeAttemptResult(actor, { ...bound, result: { ...outcome, ...(cleanupPending ? { cleanup_pending: true } : {}) }, warnings });
}

/** Reselection may repair an XMP without retransferring or rewriting the original. */
export async function attachUploadSidecar(actor: PhotoActor, body: Body): Promise<CanonicalUploadOutcome> {
  const args = uploadRpcArgs(actor, body);
  const bound = await photoRpc(actor, 'photo_lock_upload', args);
  if (bound.result?.status !== 'created' || !bound.sidecar_path || bound.sidecar_path === bound.original_path) throw new PhotoApiError('conflict');
  const sidecarName = string(body.sidecar_name);
  if (/[/\\]/.test(sidecarName) || !/\.xmp$/i.test(sidecarName)) throw new PhotoApiError('invalid_input');
  const bytes = integer(body.sidecar_bytes);
  if (await objectSize(actor, bound.sidecar_path) !== bytes) throw new PhotoApiError('conflict');
  return photoRpc(actor, 'photo_attach_upload_sidecar', { ...args, p_sidecar_name: sidecarName, p_sidecar_bytes: bytes });
}

export class OriginalUploadMismatch extends PhotoApiError {
  constructor() { super('conflict'); }
}

/** A lost transfer response never requires overwriting a complete original. */
export async function probeUploadOriginal(actor: PhotoActor, body: Body): Promise<OriginalUploadState> {
  const args = uploadRpcArgs(actor, body, true, true);
  // Renew checks current owner, batch, both generations and both live leases.
  // A completed/cancelled attempt cannot use this path to resume old transfers.
  await photoRpc(actor, 'photo_renew_upload', args);
  const bound = await photoRpc(actor, 'photo_lock_upload', uploadRpcArgs(actor, body));
  if (bound.result || bound.lease_generation !== args.p_generation || !bound.original_path) throw new PhotoApiError('conflict');
  const { data, error } = await actor.db.storage.from('photos').info(bound.original_path);
  if (error) {
    if ('status' in error && (String(error.status) === '404' ||
        (String(error.status) === '400' && error.message === 'Object not found'))) return { complete: false };
    throw new PhotoApiError('temporarily_unavailable');
  }
  if (!data || typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) {
    throw new PhotoApiError('temporarily_unavailable');
  }
  if (data.size !== Number(bound.original_bytes)) throw new OriginalUploadMismatch();
  return { complete: true };
}
