import { createClient } from "@supabase/supabase-js";
import type { PhotoStorage } from "./upload";
import { classifyMediaFailure } from "./media-retry";
import {
  abortUploadWork, createUploadRetryPolicy, MAX_UPLOAD_ATTEMPTS, object,
  UploadRequestError, type UploadRetryDeps,
} from "./upload-http";

function storageFailure(error: unknown, thrown: boolean): UploadRequestError {
  const details = object(error);
  // Supabase's upload path returns raw API JSON with string statusCode; other
  // SDK boundaries return StorageApiError with numeric status.
  const rawStatus = details?.status ?? details?.statusCode;
  const status = typeof rawStatus === "number" || typeof rawStatus === "string" ? Number(rawStatus) : undefined;
  const knownStatus = status !== undefined && Number.isFinite(status) ? status : undefined;
  const code = typeof details?.code === "string" ? details.code
    : typeof details?.error === "string" ? details.error : "storage_upload_failed";
  const message = typeof details?.message === "string" ? details.message : undefined;
  const { retryable, remedy } = classifyMediaFailure({ status: knownStatus, code, message,
    networkFailure: thrown || details?.name === "StorageUnknownError" });
  return new UploadRequestError(
    remedy ?? message ?? "Storage upload failed. Check your connection and retry.",
    { code, status: knownStatus, retryable },
  );
}

function retryAfter(error: unknown): string | undefined {
  const details = object(error);
  const value = details?.retryAfter;
  if (typeof value === "string" || typeof value === "number") return String(value);
  const headers = details?.headers;
  if (headers instanceof Headers) return headers.get("Retry-After") ?? undefined;
  const plain = object(headers);
  const header = plain?.["Retry-After"] ?? plain?.["retry-after"];
  return typeof header === "string" ? header : undefined;
}

/** Keep SDK multipart uploads while forwarding cancellation through its fetch seam. */
export function createAbortablePhotoStorage(deps: {
  supabaseUrl: string;
  anonKey: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}): PhotoStorage {
  const fetchRequest = deps.fetch ?? fetch;
  return {
    async upload(path, body, options) {
      const signal = options?.signal;
      let responseStatus: number | undefined;
      let responseRetryAfter: string | null = null;
      const client = createClient(deps.supabaseUrl, deps.anonKey, {
        accessToken: deps.getAccessToken,
        global: {
          fetch: async (input, init) => {
            signal?.throwIfAborted();
            const response = await fetchRequest(input, { ...init, signal });
            responseStatus = response.status;
            responseRetryAfter = response.headers.get("Retry-After");
            return response;
          },
        },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const result = await abortUploadWork(() => client.storage.from("photos").upload(path, body, options), signal);
      if (!result.error) return { error: null };
      return { error: Object.assign(result.error, {
        ...(responseStatus === undefined ? {} : { status: responseStatus }),
        ...(responseRetryAfter === null ? {} : { retryAfter: responseRetryAfter }),
      }) };
    },
  };
}

/** Each attempt reuses the exact object identity, bytes, and upsert policy. */
export function createRetryingPhotoStorage(deps: UploadRetryDeps & { storage: PhotoStorage }): PhotoStorage {
  return {
    async upload(path, body, options) {
      const signal = options?.signal;
      const retry = createUploadRetryPolicy(deps);
      for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
        let error: unknown;
        let thrown = false;
        try {
          const result = await abortUploadWork(() => deps.storage.upload(path, body, options), signal);
          if (!result.error) return { error: null };
          error = result.error;
        } catch (caught) {
          if (signal?.aborted || (caught instanceof Error && caught.name === "AbortError")) throw caught;
          error = caught;
          thrown = true;
        }
        const failure = error instanceof UploadRequestError ? error : storageFailure(error, thrown);
        try {
          await retry(attempt, failure, retryAfter(error), signal);
        } catch (terminal) {
          if (terminal instanceof UploadRequestError) return { error: terminal };
          throw terminal;
        }
      }
      throw new Error("Storage retry budget exhausted");
    },
  };
}
