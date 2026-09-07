import { Upload as TusUpload, type UploadOptions, type DetailedError, type HttpResponse } from "tus-js-client";
import {
  MAX_UPLOAD_ATTEMPTS, MAX_UPLOAD_RETRY_DELAY_MS, retryAfterMs,
  uploadRetryDelay, UploadRequestError,
} from "./upload-http";
import { classifyMediaFailure } from "./media-retry";
import type { ByteProgress, UploadTransferError } from "./upload";

/**
 * Resumable upload for big originals. Same result contract as
 * PhotoStorage.upload so uploadOne treats both paths identically.
 */
export type ResumableUpload = (
  path: string,
  file: File,
  options: { contentType: string; onProgress?: ByteProgress; signal?: AbortSignal; upsert?: boolean }
) => Promise<{ error: UploadTransferError | null }>;

/** Plain .upload() is for <=6 MB; anything bigger goes resumable (TUS). */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;
/** Supabase's TUS endpoint requires chunks of EXACTLY 6 MB. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

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

