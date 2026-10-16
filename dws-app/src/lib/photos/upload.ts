// Upload orchestration: per file, original FIRST, then derivatives, then POST
// the row. Storage and API clients are injected so the logic is testable
// without a browser or network.

import { UploadRequestError } from "./upload-http";
import { RESUMABLE_THRESHOLD_BYTES, type ResumableUpload } from "./upload-tus";
import { isSha256 } from "./apiShared";
import {
  extractCapturedAt as defaultExtractCapturedAt,
  type CapturedAt,
} from "./exif";
import { baseName, classifyFile, extensionOf, rewrap, type Classified } from "./classify";
import { readSidecarMeta, SIDECAR_METADATA_MAX_BYTES } from "./sidecar";
import { METADATA_MAX_BYTES, canDecodePreview, isRawImage } from "./decode-limits";
import { DERIVED_CACHE_SECONDS, ORIGINAL_CACHE_SECONDS } from "./storage-cache";
import { exceedsPreviewPixels } from "./image-size";
import {
  makeDerivatives as defaultMakeDerivatives,
  type Derivatives,
} from "./derivatives";
import type {
  AcquireUploadOutcome, AttachUploadSidecarInput, BeginUploadInput, BeginUploadOutcome, CanonicalUploadOutcome, ClaimUploadOutcome,
  CreateUploadAttemptInput, FinalizeUploadInput, FormatTwin, FormatTwinQuery, ReleaseUploadInput,
  OriginalUploadState, UploadAttempt, UploadClaimInput, UploadLeaseInput, UploadOwner,
} from "./upload-contract";

export interface UploadMeta {
  /** The project, or null for none. Every upload names a project, an album, or both. */
  jobId: string | null;
  /** Albums the photo joins. A retry must send the same list: the server
   *  compares it when an attempt is replayed. */
  albumIds?: string[];
  /** auth.uid() of the signed-in user — prefixes every storage key. */
  uploaderId: string;
  tags?: string[];
}

/** What the sheet hands the manager: meta plus per-file shutter times. */
export interface BatchMeta extends Omit<UploadMeta, "uploaderId"> {
  shutterAt?: Map<File, Date>;
}

export interface UploadIdentity {
  attemptId: string;
  photoId: string;
  contentSha256: string;
  sourceSignature: string;
}

type RequestOptions = { signal?: AbortSignal };

export interface UploadTransferError {
  message: string;
  code?: string;
  status?: number;
  retryable?: boolean;
  retryAt?: number;
  newAttemptRequired?: boolean;
}

function transferFailure(error: UploadTransferError): UploadRequestError {
  return new UploadRequestError(error.message, {
    code: error.code ?? "storage_upload_failed", status: error.status,
    retryable: error.retryable ?? false, retryAt: error.retryAt,
  });
}

function retryDetails(error: unknown): Pick<UploadResult, "retryAt" | "retryable" | "newAttemptRequired" | "errorCode" | "errorStatus"> {
  if (error === null || typeof error !== "object") return {};
  const details = error as UploadTransferError;
  return {
    retryAt: typeof details.retryAt === "number" ? details.retryAt : undefined,
    retryable: typeof details.retryable === "boolean" ? details.retryable : undefined,
    newAttemptRequired: details.newAttemptRequired,
    errorCode: details.code,
    errorStatus: typeof details.status === "number" ? details.status : undefined,
  };
}

/**
 * The connection dropped (no server answered at all), as opposed to a server
 * that answered with a refusal. Every request already retried itself a few
 * times before this, so the phone is likely in a dead spot: the manager holds
 * the batch on this file and tries it again rather than failing the rest.
 */
export function isConnectionFailure(result: Pick<UploadResult, "status" | "retryable" | "retryAt" | "errorCode" | "errorStatus">): boolean {
  return result.status === "failed" && result.retryable === true && result.retryAt === undefined &&
    result.errorStatus === undefined &&
    (result.errorCode === "network_error" || result.errorCode === "storage_upload_failed");
}

export interface PhotoStorage {
  upload(
    path: string,
    body: Blob | File,
    options?: {
      contentType?: string;
      upsert?: boolean;
      signal?: AbortSignal;
      /** Seconds browsers and the CDN may cache the file (storage-cache.ts). */
      cacheControl?: string;
    }
  ): Promise<{ error: UploadTransferError | null }>;
}

/** Byte-level progress for one file (only TUS uploads report mid-file). */
export type ByteProgress = (sentBytes: number, totalBytes: number) => void;

export interface UploadDeps {
  storage: PhotoStorage;
  hash: (file: File, options?: RequestOptions) => Promise<string>;
  createAttempt: (input: CreateUploadAttemptInput, options?: RequestOptions) => Promise<UploadAttempt>;
  /** POST .../uploads/begin: attempt, lease, claim and original check in one
   *  round trip. Without it each step is its own request (the importer, whose
   *  attempts come from its own prepare step). */
  begin?: (input: BeginUploadInput, options?: RequestOptions) => Promise<BeginUploadOutcome>;
  acquireLease: (input: UploadOwner, options?: RequestOptions) => Promise<AcquireUploadOutcome>;
  claimContent: (input: UploadLeaseInput, options?: RequestOptions) => Promise<ClaimUploadOutcome>;
  probeOriginal: (input: UploadClaimInput, options?: RequestOptions) => Promise<OriginalUploadState>;
  renewLease: (input: UploadClaimInput, options?: RequestOptions) => Promise<void>;
  releaseLease: (input: ReleaseUploadInput) => Promise<void>;
  finalize: (payload: FinalizeUploadInput, options?: RequestOptions) => Promise<CanonicalUploadOutcome>;
  attachSidecar: (input: AttachUploadSidecarInput, options?: RequestOptions) => Promise<CanonicalUploadOutcome>;
  resumableUpload: ResumableUpload;
  extractCapturedAt?: (
    file: File,
    opts?: { shutter?: Date; sidecarDate?: Date | null }
  ) => Promise<CapturedAt>;
  makeDerivatives?: (file: File) => Promise<Derivatives | null>;
  /** GET /api/photos/twin. Without it no upload is checked for a format twin. */
  findFormatTwin?: (query: FormatTwinQuery, options?: RequestOptions) => Promise<FormatTwin | null>;
  /** POST /api/photos/<id>/derive: the server makes the previews this browser
   *  could not (HEIC on a desktop, TIFF, an image over the decoding budget, a
   *  video it cannot play). Without it those photos wait for the nightly sweep. */
  deriveOnServer?: (photoId: string, options?: RequestOptions) => Promise<{ thumb_path: string | null }>;
}

export interface UploadResult {
  status: "done" | "failed" | "duplicate" | "job_conflict" | "restore_required" | "cancelled" | "waiting_claim" | "format_twin";
  error?: string;
  errorCode?: string;
  canonicalPhotoId?: string;
  /** Null when the existing photo has no project. */
  canonicalJobId?: string | null;
  purgeAfter?: string;
  warnings: string[];
  sidecarRetry?: boolean;
  retryAt?: number;
  retryable?: boolean;
  newAttemptRequired?: boolean;
  /** With status format_twin: the photo already in the project that this file looks like. */
  twin?: FormatTwin;
  /** HTTP status of the failure, when a server answered. */
  errorStatus?: number;
}

/** What a row shows while it uploads: getting the file ready, sending bytes, saving the photo. */
export type UploadStage = "preparing" | "sending" | "finishing";

/** Makes the previews the browser could not; answers the thumbnail path, or null when the server could not either. */
export type ServerDerive = () => Promise<{ thumb_path: string | null }>;

/** The words for a held format twin (plan Decision 11), in the tray and the import list. */
export const formatTwinMessage = (twin: Pick<FormatTwin, "original_name">) =>
  `Looks like another format of ${twin.original_name}`;

export const LEASE_RENEW_MS = 30_000;

function canonicalResult(
  outcome: CanonicalUploadOutcome,
  jobId: string | null,
  warnings: string[]
): UploadResult {
  const common = {
    canonicalPhotoId: outcome.photo_id,
    canonicalJobId: outcome.job_id,
    warnings: [...new Set([...warnings, ...(outcome.warnings ?? [])])],
    sidecarRetry: outcome.sidecar_retry ?? false,
  };
  if (outcome.status === "duplicate_trashed") {
    return {
      ...common, status: "restore_required", purgeAfter: outcome.purge_after ?? undefined,
      error: outcome.remedy ?? "This photo is in the trash. Restore it from Trash, then upload again.",
    };
  }
  // An upload that names no project cannot conflict with the one the existing
  // photo has: it just joins the album (the database answers skipped_duplicate).
  if (jobId !== null && outcome.job_id !== jobId) {
    return { ...common, status: "job_conflict", error: "This photo already belongs to another project. Confirm a move to use it here." };
  }
  return { ...common, status: outcome.status === "created" ? "done" : "duplicate" };
}

/** Reject at once when the signal aborts, without waiting on work that cannot be stopped. */
function stopOnAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(operation);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The work on one file that needs no server: its hash, its capture date and
 * its previews. Each step starts on first use and runs once. uploadOne makes
 * its own and runs the steps in its usual order (previews only once the
 * server has said the file is new); the manager may instead make one for the
 * NEXT file and warm() it while the current file's bytes are on the network,
 * so the phone's processor and its connection work at the same time.
 */
export interface PreparedUpload {
  /** The file as picked; uploadOne only uses a preparation made from the same file. */
  readonly source: File;
  /** The same bytes with the canonical type. */
  readonly file: File;
  readonly classified: Classified;
  digest(): Promise<string>;
  /** The capture date. Its notes collect in captureNotes. */
  capture(): Promise<CapturedAt>;
  readonly captureNotes: string[];
  /** The previews, or null. Its notes collect in previewNotes. */
  derivatives(): Promise<Derivatives | null>;
  readonly previewNotes: string[];
  /** Run every step now, one after another, so at most one photo is decoded at a time. */
  warm(): void;
}

export function prepareUpload(
  rawFile: File,
  deps: Pick<UploadDeps, "hash" | "extractCapturedAt" | "makeDerivatives">,
  opts: { shutter?: Date; sidecar?: File; signal?: AbortSignal } = {}
): PreparedUpload {
  const classified = classifyFile(rawFile);
  const file = rewrap(rawFile, classified.mime);
  const rawImage = isRawImage(file);
  const { signal } = opts;
  const guard = <T>(operation: () => Promise<T>) => stopOnAbort(operation, signal);
  const captureNotes: string[] = [];
  const previewNotes: string[] = [];
  let digest: Promise<string> | undefined;
  let capture: Promise<CapturedAt> | undefined;
  let derivatives: Promise<Derivatives | null> | undefined;
  const prepared: PreparedUpload = {
    source: rawFile, file, classified, captureNotes, previewNotes,
    digest: () => digest ??= guard(() => deps.hash(file, { signal })),
    capture: () => capture ??= guard(async (): Promise<CapturedAt> => {
      let sidecarDate: Date | null = null;
      if (opts.sidecar) {
        if (opts.sidecar.size > SIDECAR_METADATA_MAX_BYTES) {
          captureNotes.push("Sidecar capture metadata skipped: XMP exceeds the metadata size limit.");
        } else {
          try {
            sidecarDate = (await guard(() => readSidecarMeta(opts.sidecar!))).capturedAt;
          } catch {
            signal?.throwIfAborted();
            captureNotes.push("Sidecar metadata could not be read. Reselect the sidecar to retry.");
          }
        }
      }
      const captureOptions = { shutter: opts.shutter, sidecarDate };
      const fallbackCapture = () => defaultExtractCapturedAt(
        new File([], file.name, { type: "application/octet-stream", lastModified: file.lastModified }), captureOptions
      );
      if (file.size > METADATA_MAX_BYTES || rawImage) {
        if (classified.kind === "image") captureNotes.push("Embedded capture metadata skipped to limit browser memory use.");
        return fallbackCapture();
      }
      try {
        return await (deps.extractCapturedAt ?? defaultExtractCapturedAt)(file, captureOptions);
      } catch {
        captureNotes.push("Embedded capture metadata could not be read.");
        return fallbackCapture();
      }
    }),
    derivatives: () => derivatives ??= guard(async (): Promise<Derivatives | null> => {
      const skipped = "Previews skipped to limit browser decoding memory use.";
      if (!canDecodePreview(file)) {
        previewNotes.push(skipped);
        return null;
      }
      try {
        // A file size limit cannot see a 48-200 MP photo that still fits
        // under it; decoding one at full size can crash a phone's tab. The
        // server makes those previews instead (deriveOnServer).
        if (classified.kind === "image" && await exceedsPreviewPixels(file)) {
          previewNotes.push(skipped);
          return null;
        }
        const result = await (deps.makeDerivatives ?? defaultMakeDerivatives)(file);
        if (!result && classified.kind !== "file" && classified.kind !== "sidecar") {
          previewNotes.push("Previews could not be generated; the original is preserved.");
        }
        return result;
      } catch {
        previewNotes.push("Previews could not be generated; the original is preserved.");
        return null;
      }
    }),
    warm: () => {
      void prepared.digest().then(() => prepared.capture()).then(() => prepared.derivatives()).catch(() => undefined);
    },
  };
  return prepared;
}

export async function uploadOne(
  rawFile: File,
  /** Stable local queue key. Server-returned paths are the transfer authority. */
  queueId: string,
  meta: UploadMeta,
  deps: UploadDeps,
  onBytes?: ByteProgress,
  opts: {
    shutter?: Date; sidecar?: File; signal?: AbortSignal;
    identity?: UploadIdentity; onIdentity?: (identity: UploadIdentity) => void;
    expectedSidecarName?: string;
    /** Upload even when the project already holds this shot in another format. */
    keepFormatTwin?: boolean;
    /** A preparation of this same file, already started (see prepareUpload). */
    prepared?: PreparedUpload;
    /** Told when the upload moves on: preparing, then sending, then finishing. */
    onStage?: (stage: UploadStage) => void;
    /** Takes the server-preview request instead of waiting for it, so the
     *  next file need not wait. Without it the request is awaited here. */
    deriveLater?: (photoId: string, derive: ServerDerive) => void;
  } = {}
): Promise<UploadResult> {
  const warnings: string[] = [];
  let sidecarRetryAt: number | undefined;
  if (opts.expectedSidecarName && !opts.sidecar) {
    warnings.push("Sidecar file was not reselected; the original is preserved.");
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener("abort", cancel, { once: true });
  let lease: UploadLeaseInput | undefined;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewing: Promise<void> = Promise.resolve();
  const requestOptions = { signal };

  // Some decoders and older Storage adapters cannot abort an outstanding call.
  // Stop awaiting it and schedule no dependent writes after cancellation.
  const run = <T>(operation: () => Promise<T>): Promise<T> => stopOnAbort(operation, signal);
  const startRenewal = (claim: UploadClaimInput) => {
    const schedule = () => {
      timer = setTimeout(() => {
        renewing = Promise.resolve().then(() => deps.renewLease(claim, requestOptions)).then(() => {
          if (!signal.aborted) schedule();
        }).catch((error: unknown) => {
          controller.abort(error instanceof Error ? error : new Error("Upload lease renewal failed"));
        });
      }, LEASE_RENEW_MS);
    };
    schedule();
  };

  try {
    opts.onStage?.("preparing");
    const prepared = opts.prepared?.source === rawFile ? opts.prepared
      : prepareUpload(rawFile, deps, { shutter: opts.shutter, sidecar: opts.sidecar, signal });
    const { file, classified } = prepared;
    // Every size must finish the same hash/preflight contract before any bytes.
    const digest = await run(() => prepared.digest());
    if (!isSha256(digest)) throw new Error("Hashing did not return a SHA-256 digest");

    // Read once: before the claim when the format-twin check needs it, otherwise
    // beside the previews. Its notes join the warnings only once the upload gets
    // that far, so an early outcome (a duplicate) carries none of them.
    const readCapture = () => run(() => prepared.capture());

    // Format twin (plan Decision 11): the same shot already in this project in
    // another format (IMG_1234.CR2 beside IMG_1234.JPG) is held for the uploader
    // to decide, before any attempt, claim, or bytes. Album-only uploads skip it.
    if (meta.jobId !== null && classified.kind === "image" && !opts.keepFormatTwin && deps.findFormatTwin) {
      const { date } = await readCapture();
      const jobId = meta.jobId;
      const twin = date ? await run(() => deps.findFormatTwin!({
        job_id: jobId, base: baseName(file.name), captured_at: date.toISOString(), content_sha256: digest,
      }, requestOptions)) : null;
      if (twin) return { status: "format_twin", twin, error: formatTwinMessage(twin), warnings };
    }
    const sourceSignature = JSON.stringify([file.name, file.size, file.lastModified, classified.mime]);
    const unchanged = opts.identity?.contentSha256 === digest && opts.identity.sourceSignature === sourceSignature;
    let identity: UploadIdentity = unchanged ? opts.identity! : {
      attemptId: opts.identity ? crypto.randomUUID() : queueId,
      photoId: opts.identity ? crypto.randomUUID() : queueId,
      contentSha256: digest, sourceSignature,
    };
    // A fresh identity names a photo no earlier try used, so no original can
    // be stored under it yet and the original-file check can be skipped. A
    // retry of the same identity (a lost response, a dropped connection) checks.
    let fresh = !unchanged;
    let attempt: UploadAttempt;
    let acquired: AcquireUploadOutcome;
    let owner: UploadOwner;
    let begun: BeginUploadOutcome | undefined;
    for (let reset = 0; ; reset++) {
      opts.onIdentity?.(identity);
      const attemptInput: CreateUploadAttemptInput = {
        attempt_id: identity.attemptId, photo_id: identity.photoId,
        job_id: meta.jobId, album_ids: meta.albumIds ?? [],
        source_signature: sourceSignature, content_sha256: digest,
        original_name: file.name, original_bytes: file.size, mime_type: classified.mime,
      };
      if (deps.begin) {
        const beginInput: BeginUploadInput = { ...attemptInput, probe: !fresh };
        begun = await run(() => deps.begin!(beginInput, requestOptions));
        attempt = begun.attempt;
      } else {
        begun = undefined;
        attempt = await run(() => deps.createAttempt(attemptInput, requestOptions));
      }
      if (attempt.content_sha256 !== digest || attempt.job_id !== meta.jobId) {
        throw new Error("Upload attempt does not match this file and job");
      }
      owner = { owner_kind: attempt.owner_kind, owner_id: attempt.owner_id };
      const leaseOwner = owner;
      acquired = attempt.result ?? begun?.acquired ?? await run(() => deps.acquireLease(leaseOwner, requestOptions));
      if (acquired.status === "acquired") break;
      if (acquired.new_attempt_required) {
        if (reset > 0) throw new Error("Upload attempt could not be reset; retry shortly");
        identity = { ...identity, attemptId: crypto.randomUUID(), photoId: crypto.randomUUID() };
        fresh = true;
        continue;
      }
      if (acquired.status === "created" && acquired.sidecar_retry && opts.sidecar) {
        return await retrySidecar(opts.sidecar, identity, meta, deps, requestOptions);
      }
      return canonicalResult(acquired, meta.jobId, warnings);
    }
    lease = { ...owner, lease_generation: acquired.lease_generation };
    const leased = lease;
    const claimed = begun?.claimed ?? await run(() => deps.claimContent(leased, requestOptions));
    if (claimed.status === "waiting_claim") {
      const retryAt = Date.parse(claimed.lease_expires_at);
      return { status: "waiting_claim", error: "Another upload is processing these bytes. Retry shortly.", warnings,
        retryable: true, retryAt: Number.isFinite(retryAt) ? retryAt : undefined };
    }
    if (claimed.status !== "claimed") {
      completed = true;
      return canonicalResult(claimed, meta.jobId, warnings);
    }
    const claim: UploadClaimInput = { ...lease, claim_generation: claimed.claim_generation };
    startRenewal(claim);
    // A prior transfer may have completed despite a lost response or expired
    // TUS URL. The server checks the bound path and size under this exact claim.
    if (begun?.original_mismatch) {
      throw new UploadRequestError("Stored upload differs from this file. Start a fresh attempt before retrying.", {
        code: "conflict", status: 409, retryable: false, newAttemptRequired: true,
      });
    }
    const originalState: OriginalUploadState = begun?.original
      ?? (fresh && attempt.photo_id === identity.photoId ? { complete: false }
        : await run(() => deps.probeOriginal(claim, requestOptions)));

    const capturedAt = await readCapture();
    warnings.push(...prepared.captureNotes);
    const derivatives = await run(() => prepared.derivatives());
    warnings.push(...prepared.previewNotes);

    const transfer = (path: string, body: File, contentType: string, progress?: ByteProgress) =>
      run(() => body.size > RESUMABLE_THRESHOLD_BYTES
        ? deps.resumableUpload(path, body, { contentType, onProgress: progress, signal, cacheControl: ORIGINAL_CACHE_SECONDS })
        : deps.storage.upload(path, body, { contentType, upsert: true, signal, cacheControl: ORIGINAL_CACHE_SECONDS }));
    opts.onStage?.("sending");
    // Original FIRST: every intermediate state remains repairable.
    if (!originalState.complete) {
      const original = await transfer(attempt.original_path, file, classified.mime, onBytes);
      if (original.error) throw transferFailure(original.error);
    }
    onBytes?.(file.size, file.size);

    let sidecarPath: string | null = null;
    if (opts.sidecar) {
      try {
        const sidecar = await transfer(attempt.sidecar_path, rewrap(opts.sidecar, "application/rdf+xml"), "application/rdf+xml");
        if (sidecar.error) throw transferFailure(sidecar.error);
        sidecarPath = attempt.sidecar_path;
      } catch (error) {
        signal.throwIfAborted();
        sidecarRetryAt = retryDetails(error).retryAt;
        warnings.push("Sidecar upload failed. Reselect the original and sidecar to retry.");
      }
    }
    const uploadDerivative = async (path: string, body: Blob): Promise<string | null> => {
      try {
        // body.type is the real format (WebP, or JPEG where the browser
        // cannot encode WebP), whatever the key's .webp name says.
        const result = await run(() => deps.storage.upload(path, body, {
          contentType: body.type || "image/webp", upsert: true, signal,
          cacheControl: DERIVED_CACHE_SECONDS,
        }));
        if (result.error) throw new Error(result.error.message);
        return path;
      } catch {
        signal.throwIfAborted();
        warnings.push(path === attempt.thumb_path ? "Thumbnail upload failed; the original is preserved." : "Preview upload failed; the original is preserved.");
        return null;
      }
    };
    const [thumbPath, previewPath] = derivatives ? await Promise.all([
      uploadDerivative(attempt.thumb_path, derivatives.thumb),
      uploadDerivative(attempt.preview_path, derivatives.preview),
    ]) : [null, null];

    opts.onStage?.("finishing");
    // Fence a failed in-flight renewal before committing; the server checks both generations.
    clearTimeout(timer);
    await run(() => renewing);
    clearTimeout(timer);
    const result = await run(() => deps.finalize({
      ...claim, id: attempt.photo_id, job_id: meta.jobId,
      kind: classified.kind === "sidecar" ? "file" : classified.kind,
      tags: meta.tags ?? [],
      captured_at: capturedAt.date ? capturedAt.date.toISOString() : null,
      captured_at_source: capturedAt.source,
      original_path: attempt.original_path, original_bytes: file.size,
      mime_type: classified.mime, original_name: file.name,
      thumb_path: thumbPath, preview_path: previewPath,
      duration_secs: derivatives?.durationSecs ?? null,
      sidecar_path: sidecarPath, sidecar_name: sidecarPath ? opts.sidecar!.name : null,
      content_sha256: digest, warnings,
    }, requestOptions));
    completed = true;
    // The row is in; previews the browser could not make are made on the
    // server now. A failure there changes nothing: the sweep fills it later
    // and the note stands. With deriveLater the caller sends the request and
    // this file is done at once, so a slow server render (a long video, a
    // big TIFF) never holds up the next file.
    let reported = warnings;
    if (result.status === "created" && !derivatives && deps.deriveOnServer
        && (classified.kind === "image" || classified.kind === "video")) {
      const photoId = attempt.photo_id;
      const deriveOnServer = deps.deriveOnServer;
      if (opts.deriveLater) {
        opts.deriveLater(photoId, () => deriveOnServer(photoId));
      } else {
        try {
          const made = await deriveOnServer(photoId, requestOptions);
          if (made.thumb_path) reported = withoutPreviewNotes(warnings);
        } catch {
          // Left to the sweep.
        }
      }
    }
    // Only the server may clean unreferenced duplicate objects after commit.
    return {
      ...canonicalResult(result, meta.jobId, reported),
      sidecarRetry: result.status === "created" && (result.sidecar_retry || (!sidecarPath && Boolean(opts.sidecar || opts.expectedSidecarName))),
      retryAt: sidecarRetryAt,
    };
  } catch (error) {
    return {
      status: opts.signal?.aborted ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : "Upload failed", warnings,
      ...retryDetails(error),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
    if (lease && !completed) {
      // Transport interruption remains retryable; explicit batch cancellation is server-owned.
      // No aborted signal: releasing a fenced lease must still be attempted.
      await deps.releaseLease({ ...lease, status: "retryable_failed" }).catch(() => undefined);
    }
  }
}

/** The upload's "Previews ..." notes, dropped once the server has made the previews. */
export const withoutPreviewNotes = (warnings: string[]) => warnings.filter((warning) => !warning.startsWith("Previews "));

/** Attach a reselected XMP to an owned completed attempt without reuploading the original. */
export async function retrySidecar(
  sidecar: File,
  identity: UploadIdentity,
  meta: UploadMeta,
  deps: UploadDeps,
  options: RequestOptions = {}
): Promise<UploadResult> {
  try {
    options.signal?.throwIfAborted();
    if (extensionOf(sidecar.name) !== "xmp") throw new Error("Select an XMP sidecar file");
    const source: unknown = JSON.parse(identity.sourceSignature);
    if (!Array.isArray(source) || source.length !== 4 || typeof source[0] !== "string" ||
        !Number.isSafeInteger(source[1]) || source[1] < 0 || typeof source[3] !== "string") {
      throw new Error("Original upload identity is unavailable; reselect the original and sidecar");
    }
    const attempt = await deps.createAttempt({
      attempt_id: identity.attemptId, photo_id: identity.photoId, job_id: meta.jobId,
      album_ids: meta.albumIds ?? [],
      source_signature: identity.sourceSignature, content_sha256: identity.contentSha256,
      original_name: source[0], original_bytes: source[1], mime_type: source[3],
    }, options);
    options.signal?.throwIfAborted();
    if (!attempt.result) throw new Error("Complete the original upload before attaching its sidecar");
    if (attempt.result.status !== "created") {
      return canonicalResult(attempt.result, meta.jobId, []);
    }
    if (!attempt.result.sidecar_retry) {
      if (attempt.result.sidecar_attached) return canonicalResult(attempt.result, meta.jobId, []);
      throw new Error("This original is no longer eligible for sidecar attachment");
    }
    // Never replace existing bytes: a prior attach may have committed despite a
    // lost response. Storage metadata verification below resolves that replay.
    const file = rewrap(sidecar, "application/rdf+xml");
    let transferError: unknown;
    try {
      const transferred = file.size > RESUMABLE_THRESHOLD_BYTES
        ? await deps.resumableUpload(attempt.sidecar_path, file, { ...options, contentType: file.type, upsert: false, cacheControl: ORIGINAL_CACHE_SECONDS })
        : await deps.storage.upload(attempt.sidecar_path, file, { ...options, contentType: file.type, upsert: false, cacheControl: ORIGINAL_CACHE_SECONDS });
      transferError = transferred.error;
    } catch (error) { transferError = error; }
    options.signal?.throwIfAborted();
    // Even after an ambiguous transfer error the server may verify the complete
    // existing object. Missing/wrong-size objects are rejected by this boundary.
    try {
      const result = await deps.attachSidecar({ owner_kind: attempt.owner_kind, owner_id: attempt.owner_id,
        sidecar_name: sidecar.name, sidecar_bytes: sidecar.size }, options);
      return canonicalResult(result, meta.jobId, []);
    } catch (error) { throw transferError ?? error; }
  } catch (error) {
    return { status: options.signal?.aborted ? "cancelled" : "failed", sidecarRetry: true,
      error: error instanceof Error ? error.message : "Sidecar attachment failed",
      warnings: ["Sidecar upload failed. Reselect the sidecar to retry."], ...retryDetails(error) };
  }
}
