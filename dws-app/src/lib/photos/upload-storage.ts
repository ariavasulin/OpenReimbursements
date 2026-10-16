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

/**
 * Names the upload call a request belongs to, on its way from upload() into
 * the client's fetch. Removed before the request leaves the browser.
 */
const CALL_HEADER = "x-photos-upload-call";

/**
 * Keep SDK multipart uploads while forwarding cancellation through its fetch
 * seam. One client serves every upload this storage makes (it was three per
 * photo); the SDK takes no per-call signal, so each call tags its request with
 * a header the fetch seam reads, strips, and maps to that call's signal.
 */
export function createAbortablePhotoStorage(deps: {
  supabaseUrl: string;
  anonKey: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}): PhotoStorage {
  const fetchRequest = deps.fetch ?? fetch;
  const calls = new Map<string, { signal?: AbortSignal; status?: number; retryAfter: string | null }>();
  let lastCall = 0;
  const client = createClient(deps.supabaseUrl, deps.anonKey, {
    accessToken: deps.getAccessToken,
    global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const call = calls.get(headers.get(CALL_HEADER) ?? "");
        headers.delete(CALL_HEADER);
        const signal = call?.signal;
        signal?.throwIfAborted();
        const response = await fetchRequest(input, { ...init, headers, signal });
        if (call) {
          call.status = response.status;
          call.retryAfter = response.headers.get("Retry-After");
        }
        return response;
      },
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async upload(path, body, options) {
      const signal = options?.signal;
      const id = String(++lastCall);
      const call: { signal?: AbortSignal; status?: number; retryAfter: string | null } = { signal, retryAfter: null };
      calls.set(id, call);
      try {
        const result = await abortUploadWork(() => client.storage.from("photos").upload(path, body, {
          ...options, headers: { [CALL_HEADER]: id },
        }), signal);
        if (!result.error) return { error: null };
        return { error: Object.assign(result.error, {
          ...(call.status === undefined ? {} : { status: call.status }),
          ...(call.retryAfter === null ? {} : { retryAfter: call.retryAfter }),
        }) };
      } finally {
        calls.delete(id);
      }
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
