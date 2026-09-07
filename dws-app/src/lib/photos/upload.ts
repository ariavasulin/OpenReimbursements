// Upload orchestration: per file, original FIRST, then derivatives, then POST
// the row. Storage and API clients are injected so the logic is testable
// without a browser or network.

import { Upload as TusUpload, type UploadOptions, type DetailedError, type HttpResponse } from "tus-js-client";
import {
  MAX_UPLOAD_ATTEMPTS, MAX_UPLOAD_RETRY_DELAY_MS, retryAfterMs,
  uploadRetryDelay, UploadRequestError,
} from "./upload-http";
import { classifyMediaFailure } from "./media-retry";
import {
  extractCapturedAt as defaultExtractCapturedAt,
  type CapturedAt,
} from "./exif";
import { classifyFile, extensionOf, rewrap } from "./classify";
import { readSidecarMeta, SIDECAR_METADATA_MAX_BYTES } from "./sidecar";
import { METADATA_MAX_BYTES, DERIVATIVES_MAX_BYTES, isRawImage } from "./decode-limits";
export { METADATA_MAX_BYTES, DERIVATIVES_MAX_BYTES } from "./decode-limits";
export { SIDECAR_METADATA_MAX_BYTES } from "./sidecar";
import {
  makeDerivatives as defaultMakeDerivatives,
  type Derivatives,
} from "./derivatives";
import type {
  AcquireUploadOutcome, AttachUploadSidecarInput, CanonicalUploadOutcome, ClaimUploadOutcome,
  CreateUploadAttemptInput, FinalizeUploadInput, ReleaseUploadInput,
  OriginalUploadState, UploadAttempt, UploadClaimInput, UploadLeaseInput, UploadOwner,
} from "./upload-contract";

export interface UploadMeta {
  jobId: string;
  /** auth.uid() of the signed-in user — prefixes every storage key. */
  uploaderId: string;
  sheetNumber?: string | null;
  tags?: string[];
}

/** What the sheet hands the manager: meta plus per-file shutter times. */
export interface BatchMeta extends Omit<UploadMeta, "uploaderId"> {
  shutterAt?: Map<File, Date>;
}

/** Shared server-validated finalize contract; bytes go directly to Storage. */
export type FinalizePayload = FinalizeUploadInput;

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

function retryDetails(error: unknown): Pick<UploadResult, "retryAt" | "retryable" | "newAttemptRequired" | "errorCode"> {
  if (error === null || typeof error !== "object") return {};
  const details = error as UploadTransferError;
  return {
    retryAt: typeof details.retryAt === "number" ? details.retryAt : undefined,
    retryable: typeof details.retryable === "boolean" ? details.retryable : undefined,
    newAttemptRequired: details.newAttemptRequired,
    errorCode: details.code,
  };
}

export interface PhotoStorage {
  upload(
    path: string,
    body: Blob | File,
    options?: { contentType?: string; upsert?: boolean; signal?: AbortSignal }
  ): Promise<{ error: UploadTransferError | null }>;
}

/** Byte-level progress for one file (only TUS uploads report mid-file). */
export type ByteProgress = (sentBytes: number, totalBytes: number) => void;

/**
 * Resumable upload for big originals. Same result contract as
 * PhotoStorage.upload so uploadOne treats both paths identically.
 */
export type ResumableUpload = (
  path: string,
  file: File,
  options: { contentType: string; onProgress?: ByteProgress; signal?: AbortSignal; upsert?: boolean }
) => Promise<{ error: UploadTransferError | null }>;

export interface UploadDeps {
  storage: PhotoStorage;
  hash: (file: File, options?: RequestOptions) => Promise<string>;
  createAttempt: (input: CreateUploadAttemptInput, options?: RequestOptions) => Promise<UploadAttempt>;
  acquireLease: (input: UploadOwner, options?: RequestOptions) => Promise<AcquireUploadOutcome>;
  claimContent: (input: UploadLeaseInput, options?: RequestOptions) => Promise<ClaimUploadOutcome>;
  probeOriginal: (input: UploadClaimInput, options?: RequestOptions) => Promise<OriginalUploadState>;
  renewLease: (input: UploadClaimInput, options?: RequestOptions) => Promise<void>;
  releaseLease: (input: ReleaseUploadInput) => Promise<void>;
  finalize: (payload: FinalizePayload, options?: RequestOptions) => Promise<CanonicalUploadOutcome>;
  attachSidecar: (input: AttachUploadSidecarInput, options?: RequestOptions) => Promise<CanonicalUploadOutcome>;
  resumableUpload: ResumableUpload;
  extractCapturedAt?: (
    file: File,
    opts?: { shutter?: Date; sidecarDate?: Date | null }
  ) => Promise<CapturedAt>;
  makeDerivatives?: (file: File) => Promise<Derivatives | null>;
}

export interface UploadResult {
  status: "done" | "failed" | "duplicate" | "job_conflict" | "restore_required" | "cancelled" | "waiting_claim";
  error?: string;
  errorCode?: string;
  canonicalPhotoId?: string;
  canonicalJobId?: string;
  purgeAfter?: string;
  warnings: string[];
  sidecarRetry?: boolean;
  retryAt?: number;
  retryable?: boolean;
  newAttemptRequired?: boolean;
}

/** Plain .upload() is for <=6 MB; anything bigger goes resumable (TUS). */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;
/** Supabase's TUS endpoint requires chunks of EXACTLY 6 MB. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
/** Decoder budgets are independent of the streaming hash/transport budget. */
export const LEASE_RENEW_MS = 30_000;

const PHOTOS_BUCKET = "photos";

/** Minimal structural view of tus-js-client's Upload, so tests inject fakes. */
export interface TusUploadLike {
  start(): void;
  abort(shouldTerminate?: boolean): Promise<void>;
  findPreviousUploads(): Promise<unknown[]>;
  resumeFromPreviousUpload(previousUpload: unknown): void;
}

export type TusUploadCtor = new (
  file: File,
  options: UploadOptions
) => TusUploadLike;

export interface ResumableUploadConfig {
  /** e.g. process.env.NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl: string;
  /**
   * Called before EVERY chunk request — access tokens expire (~1 h) while a
   * multi-GB LTE upload is still running, so each chunk re-reads the current
   * token (supabase.auth.getSession() refreshes an expired one).
   */
  getAccessToken: () => Promise<string | null>;
  /** Explicit refresh once after a 401; a second rejection requires sign-in. */
  refreshAuth: () => Promise<boolean>;
  random?: () => number;
  now?: () => number;
  /** Test seam; defaults to the real tus-js-client Upload. */
  UploadCtor?: TusUploadCtor;
}

/**
 * Build the ResumableUpload dep: browser -> Supabase Storage directly over
 * TUS (originals can be multi-GB; they never pass through a Next.js route).
 */
export function createResumableUpload(
  config: ResumableUploadConfig
): ResumableUpload {
  const UploadCtor: TusUploadCtor =
    config.UploadCtor ?? (TusUpload as unknown as TusUploadCtor);

  return (path, file, options) =>
    new Promise((resolve) => {
      let settled = false;
      let refreshAttempted = false;
      let refreshPending = false;
      let terminalError: UploadRequestError | undefined;
      const now = config.now ?? Date.now;
      const responses = new WeakMap<object, HttpResponse>();
      const responseFor = (error: Error | DetailedError) => {
        const detailed = error as DetailedError;
        return detailed.originalResponse ?? (detailed.originalRequest && responses.get(detailed.originalRequest));
      };
      const failureFor = (error: Error | DetailedError): UploadRequestError => {
        if (terminalError) return terminalError;
        const response = responseFor(error);
        const status = response?.getStatus() ?? 0;
        let body: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(response?.getBody?.() ?? "");
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch { /* A proxy may return a non-JSON error page. */ }
        const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : undefined;
        const providerMessage = typeof body?.message === "string" ? body.message : error.message;
        const currentTime = now();
        const retryAfter = retryAfterMs(response?.getHeader("Retry-After"), currentTime);
        const { retryable, remedy } = classifyMediaFailure({
          status: status || undefined, code, message: providerMessage,
          networkFailure: status === 0, allowStorageLockRetry: true,
        });
        const retryAt = retryable && retryAfter !== undefined && retryAfter > MAX_UPLOAD_RETRY_DELAY_MS
          ? currentTime + retryAfter : undefined;
        const message = remedy ?? (status === 401 ? "Signed out — sign in and retry"
          : status === 403 ? "Upload permission denied. Sign in with an authorized account."
          : status === 413 ? "File exceeds the Storage quota or upload size limit."
          : status === 415 ? "This file type is not supported by Storage."
          : providerMessage);
        return new UploadRequestError(retryAt ? `${message} Retry after ${new Date(retryAt).toISOString()}.` : message, {
          code: status === 401 ? "unauthenticated" : code ?? "storage_upload_failed", status: status || undefined, retryable, retryAt,
        });
      };
      const settle = (error: UploadTransferError | null) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", cancel);
        resolve({ error });
      };
      const cancel = () => {
        // Stop requests, but retain the URL/fingerprint for an unchanged retry.
        void upload.abort(false).catch(() => undefined);
        settle({ message: "Upload cancelled" });
      };
      if (options.signal?.aborted) {
        resolve({ error: { message: "Upload cancelled" } });
        return;
      }

      const upload = new UploadCtor(file, {
        endpoint: `${config.supabaseUrl}/storage/v1/upload/resumable`,
        chunkSize: TUS_CHUNK_BYTES,
        // tus reads the selected slot immediately after onShouldRetry returns.
        // Four retries means at most five attempts without accepted-byte progress.
        retryDelays: Array(MAX_UPLOAD_ATTEMPTS - 1).fill(0),
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        // tus-js-client's default fingerprint omits the objectName. Including
        // the path scopes resumes to THIS object: a retry with the same
        // photoId (same path) resumes its own bytes, and an upload to a
        // different path can never adopt a dead attempt's URL.
        fingerprint: async () =>
          [
            "tus-sb",
            PHOTOS_BUCKET,
            path,
            file.name,
            file.type,
            file.size,
            file.lastModified,
          ].join("-"),
        headers: { "x-upsert": String(options.upsert ?? true) },
        metadata: {
          bucketName: PHOTOS_BUCKET,
          objectName: path,
          contentType: options.contentType,
          cacheControl: "3600",
        },
        // Fresh token on every request — this is what lets a chunk sent an
        // hour into an upload (or a resume after a kill) still authorize.
        onBeforeRequest: async (req) => {
          options.signal?.throwIfAborted();
          if (refreshPending) {
            refreshPending = false;
            let refreshed = false;
            try { refreshed = await config.refreshAuth(); } catch { /* Sign-in is required below. */ }
            options.signal?.throwIfAborted();
            if (!refreshed) {
              terminalError = new UploadRequestError("Signed out — sign in and retry", {
                code: "unauthenticated", status: 401, retryable: false,
              });
              throw terminalError;
            }
          }
          const token = await config.getAccessToken();
          options.signal?.throwIfAborted();
          if (!token) {
            terminalError = new UploadRequestError("Signed out — sign in and retry", {
              code: "unauthenticated", status: 401, retryable: false,
            });
            throw terminalError;
          }
          req.setHeader("Authorization", `Bearer ${token}`);
        },
        onAfterResponse: (req, response) => {
          responses.set(req, response);
          const status = response.getStatus();
          // tus otherwise recreates an upload immediately after a failed HEAD,
          // bypassing its retry callback. Only an expired/missing URL may do so.
          if (req.getMethod() === "HEAD" && (status < 200 || status >= 300) && status !== 404 && status !== 410) {
            throw new Error(`Resuming upload failed (HTTP ${status})`);
          }
        },
        onShouldRetry: (error, retryAttempt, retryOptions) => {
          if (options.signal?.aborted || terminalError || retryAttempt >= MAX_UPLOAD_ATTEMPTS - 1) return false;
          const response = responseFor(error);
          const status = response?.getStatus() ?? 0;
          if (status === 401) {
            if (refreshAttempted) return false;
            refreshAttempted = true;
            refreshPending = true;
            retryOptions.retryDelays![retryAttempt] = 0;
            return true;
          }
          const failure = failureFor(error);
          if (!failure.retryable) return false;
          if (failure.retryAt !== undefined) {
            terminalError = failure;
            return false;
          }
          const requestedDelay = retryAfterMs(response?.getHeader("Retry-After"), now()) ?? 0;
          retryOptions.retryDelays![retryAttempt] = Math.max(requestedDelay, uploadRetryDelay(retryAttempt + 1, config.random));
          return true;
        },
        onProgress: (sent, total) => {
          if (!settled) options.onProgress?.(sent, total);
        },
        onError: (error) => settle(failureFor(error)),
        onSuccess: () => settle(null),
      });
      options.signal?.addEventListener("abort", cancel, { once: true });

      // Upload URLs stay valid for 24 h.
      upload
        .findPreviousUploads()
        .then((previous) => {
          if (settled) return;
          if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
          upload.start();
        })
        .catch(() => { if (!settled) upload.start(); });
    });
}

/** Storage keys must be safe ASCII; the true filename lives in original_name. */
export function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const clean = (part: string) =>
    part
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  const cleanBase = clean(base) || "file";
  const cleanExt = clean(ext);
  return cleanExt ? `${cleanBase}.${cleanExt}` : cleanBase;
}

export function storagePaths(uploaderId: string, photoId: string, filename: string) {
  const sanitized = sanitizeFilename(filename);
  const ext = extensionOf(sanitized);
  const base = ext ? sanitized.slice(0, -(ext.length + 1)) : sanitized;
  return {
    original: `originals/${uploaderId}/${photoId}/${sanitized}`,
    sidecar: `originals/${uploaderId}/${photoId}/${base}.xmp`,
    thumb: `derived/${uploaderId}/${photoId}_thumb.webp`,
    preview: `derived/${uploaderId}/${photoId}_preview.webp`,
  };
}

function canonicalResult(
  outcome: CanonicalUploadOutcome,
  jobId: string,
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
      error: outcome.remedy ?? "Ask an administrator to restore this photo, or use the MCP restore handoff.",
    };
  }
  if (outcome.job_id !== jobId) {
    return { ...common, status: "job_conflict", error: "This photo belongs to another job. Confirm a move to use it here." };
  }
  return { ...common, status: outcome.status === "created" ? "done" : "duplicate" };
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
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
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
    const classified = classifyFile(rawFile);
    const file = rewrap(rawFile, classified.mime);
    const rawImage = isRawImage(file);
    // Every size must finish the same hash/preflight contract before any bytes.
    const digest = await run(() => deps.hash(file, requestOptions));
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Hashing did not return a SHA-256 digest");
    const sourceSignature = JSON.stringify([file.name, file.size, file.lastModified, classified.mime]);
    const unchanged = opts.identity?.contentSha256 === digest && opts.identity.sourceSignature === sourceSignature;
    let identity: UploadIdentity = unchanged ? opts.identity! : {
      attemptId: opts.identity ? crypto.randomUUID() : queueId,
      photoId: opts.identity ? crypto.randomUUID() : queueId,
      contentSha256: digest, sourceSignature,
    };
    let attempt: UploadAttempt;
    let acquired: AcquireUploadOutcome;
    let owner: UploadOwner;
    for (let reset = 0; ; reset++) {
      opts.onIdentity?.(identity);
      attempt = await run(() => deps.createAttempt({
        attempt_id: identity.attemptId, photo_id: identity.photoId,
        job_id: meta.jobId, source_signature: sourceSignature, content_sha256: digest,
        original_name: file.name, original_bytes: file.size, mime_type: classified.mime,
      }, requestOptions));
      if (attempt.content_sha256 !== digest || attempt.job_id !== meta.jobId) {
        throw new Error("Upload attempt does not match this file and job");
      }
      owner = { owner_kind: attempt.owner_kind, owner_id: attempt.owner_id };
      acquired = attempt.result ?? await run(() => deps.acquireLease(owner, requestOptions));
      if (acquired.status === "acquired") break;
      if (acquired.new_attempt_required) {
        if (reset > 0) throw new Error("Upload attempt could not be reset; retry shortly");
        identity = { ...identity, attemptId: crypto.randomUUID(), photoId: crypto.randomUUID() };
        continue;
      }
      if (acquired.status === "created" && acquired.sidecar_retry && opts.sidecar) {
        return await retrySidecar(opts.sidecar, identity, meta, deps, requestOptions);
      }
      return canonicalResult(acquired, meta.jobId, warnings);
    }
    lease = { ...owner, lease_generation: acquired.lease_generation };
    const leased = lease;
    const claimed = await run(() => deps.claimContent(leased, requestOptions));
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
    const originalState = await run(() => deps.probeOriginal(claim, requestOptions));

    let sidecarDate: Date | null = null;
    if (opts.sidecar) {
      if (opts.sidecar.size > SIDECAR_METADATA_MAX_BYTES) {
        warnings.push("Sidecar capture metadata skipped: XMP exceeds the metadata size limit.");
      } else {
        try {
          // The parser receives at most 1 MiB, even if its implementation reads all text.
          const bytes = await run(() => opts.sidecar!.slice(0, SIDECAR_METADATA_MAX_BYTES).arrayBuffer());
          sidecarDate = (await readSidecarMeta(new File([bytes], opts.sidecar.name))).capturedAt;
        } catch (error) {
          signal.throwIfAborted();
          warnings.push("Sidecar metadata could not be read. Reselect the sidecar to retry.");
        }
      }
    }
    const captureOptions = { shutter: opts.shutter, sidecarDate };
    const fallbackCapture = () => defaultExtractCapturedAt(
      new File([], file.name, { type: "application/octet-stream", lastModified: file.lastModified }), captureOptions
    );
    const [capturedAt, derivatives] = await run(() => Promise.all([
      (async (): Promise<CapturedAt> => {
        if (file.size > METADATA_MAX_BYTES || rawImage) {
          if (classified.kind === "image") warnings.push("Embedded capture metadata skipped to limit browser memory use.");
          return fallbackCapture();
        }
        try {
          return await (deps.extractCapturedAt ?? defaultExtractCapturedAt)(file, captureOptions);
        } catch {
          warnings.push("Embedded capture metadata could not be read.");
          return fallbackCapture();
        }
      })(),
      (async (): Promise<Derivatives | null> => {
        if (file.size > DERIVATIVES_MAX_BYTES || rawImage) {
          warnings.push("Previews skipped to limit browser decoding memory use.");
          return null;
        }
        try {
          const result = await (deps.makeDerivatives ?? defaultMakeDerivatives)(file);
          if (!result && classified.kind !== "file" && classified.kind !== "sidecar") {
            warnings.push("Previews could not be generated; the original is preserved.");
          }
          return result;
        } catch {
          warnings.push("Previews could not be generated; the original is preserved.");
          return null;
        }
      })(),
    ]));

    const transfer = (path: string, body: File, contentType: string, progress?: ByteProgress) =>
      run(() => body.size > RESUMABLE_THRESHOLD_BYTES
        ? deps.resumableUpload(path, body, { contentType, onProgress: progress, signal })
        : deps.storage.upload(path, body, { contentType, upsert: true, signal }));
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
        const result = await run(() => deps.storage.upload(path, body, {
          contentType: body.type || "image/webp", upsert: true, signal,
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

    // Fence a failed in-flight renewal before committing; the server checks both generations.
    clearTimeout(timer);
    await run(() => renewing);
    clearTimeout(timer);
    const result = await run(() => deps.finalize({
      ...claim, id: attempt.photo_id, job_id: meta.jobId,
      kind: classified.kind === "sidecar" ? "file" : classified.kind,
      sheet_number: meta.sheetNumber?.trim() || null, tags: meta.tags ?? [],
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
    // Only the server may clean unreferenced duplicate objects after commit.
    return {
      ...canonicalResult(result, meta.jobId, warnings),
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
        ? await deps.resumableUpload(attempt.sidecar_path, file, { ...options, contentType: file.type, upsert: false })
        : await deps.storage.upload(attempt.sidecar_path, file, { ...options, contentType: file.type, upsert: false });
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
