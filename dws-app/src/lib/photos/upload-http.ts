const OPERATIONS = new Set(["attempt", "acquire", "claim", "renew", "release", "sidecar", "original", "finalize"]);
export const MAX_UPLOAD_ATTEMPTS = 5;
export const MAX_UPLOAD_RETRY_DELAY_MS = 20_000;

type RequestOptions = { signal?: AbortSignal };
export type UploadRetryDeps = {
  refreshAuth: () => Promise<boolean>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export class UploadRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  /** Earliest suggested retry, in epoch milliseconds. */
  readonly retryAt?: number;

  constructor(message: string, details: { code: string; status?: number; retryable: boolean; retryAt?: number }) {
    super(message);
    this.name = "UploadRequestError";
    this.code = details.code;
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAt = details.retryAt;
  }
}

export function abortUploadWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("Upload cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : undefined;
}

export function uploadRetryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.max(0, Math.min(1, random())) * Math.min(MAX_UPLOAD_RETRY_DELAY_MS, 3000 * 2 ** (attempt - 1));
}

/** One policy instance per operation; HTTP and Storage share the same retry budget. */
export function createUploadRetryPolicy(deps: UploadRetryDeps) {
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  let refreshed = false;
  return async (attempt: number, failure: UploadRequestError, retryAfter?: string | null, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (failure.status === 401) {
      if (!refreshed && attempt < MAX_UPLOAD_ATTEMPTS) {
        refreshed = true;
        let authenticated = false;
        try {
          authenticated = await abortUploadWork(deps.refreshAuth, signal);
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        }
        if (authenticated) return;
      }
      throw new UploadRequestError("Signed out — sign in and retry", { code: "unauthenticated", status: 401, retryable: false });
    }
    if (!failure.retryable) throw failure;
    const currentTime = now();
    const retryDelay = retryAfterMs(retryAfter, currentTime);
    if (retryDelay !== undefined && retryDelay > MAX_UPLOAD_RETRY_DELAY_MS) {
      const retryAt = currentTime + retryDelay;
      const due = new Date(retryAt);
      const remedy = Number.isNaN(due.getTime()) ? `Retry in ${Math.ceil(retryDelay / 1000)} seconds.` : `Retry after ${due.toISOString()}.`;
      throw new UploadRequestError(`${failure.message} ${remedy}`, {
        code: failure.code, status: failure.status, retryable: true, retryAt,
      });
    }
    if (attempt === MAX_UPLOAD_ATTEMPTS) throw failure;
    await abortUploadWork(() => wait(Math.max(retryDelay ?? 0, uploadRetryDelay(attempt, deps.random)), signal), signal);
  };
}

/** Browser-cookie requests to the shared upload boundaries, with bounded retries. */
export function createUploadRequest(deps: UploadRetryDeps & { fetch?: typeof fetch }) {
  const fetchRequest = deps.fetch ?? fetch;

  return async function uploadRequest<T>(operation: string, input: unknown, { signal }: RequestOptions = {}): Promise<T> {
    if (!OPERATIONS.has(operation)) {
      throw new UploadRequestError("Unknown upload operation", { code: "invalid_input", retryable: false });
    }
    const path = operation === "finalize" ? "/api/photos" : `/api/photo-migrations/uploads/${operation}`;
    const body = JSON.stringify(input);
    const retry = createUploadRetryPolicy(deps);
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      let response: Response | undefined;
      let failure = new UploadRequestError("Upload connection interrupted. Check your connection and retry.", {
        code: "network_error", retryable: true,
      });
      try {
        response = await abortUploadWork(() => fetchRequest(path, {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body, signal,
        }), signal);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      }
      if (response) {
        let payload: unknown;
        try {
          payload = await abortUploadWork(() => response!.json(), signal);
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          if (response.ok) throw new UploadRequestError("Upload server returned an unreadable response. Retry the upload.", {
            code: "invalid_response", status: response.status, retryable: true,
          });
        }
        if (response.ok) return payload as T;
        const error = object(object(payload)?.error);
        failure = new UploadRequestError(
          typeof error?.message === "string" ? error.message : `Upload request failed (HTTP ${response.status}).`,
          { code: typeof error?.code === "string" ? error.code : "upload_request_failed", status: response.status,
            retryable: response.status === 429 || response.status >= 500 },
        );
      }
      await retry(attempt, failure, response?.headers.get("Retry-After"), signal);
    }
    throw new Error("Upload retry budget exhausted");
  };
}
