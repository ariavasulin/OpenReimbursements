import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadRequest, UploadRequestError } from "./upload-http";

const success = () => Response.json({ status: "created" });
const failure = (status: number, retryAfter?: string) => Response.json(
  { error: { code: "server_code", message: "The upload needs attention", retryable: true } },
  { status, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } },
);

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success());
  const refreshAuth = vi.fn(async () => true);
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
  const random = vi.fn(() => 1);
  const now = vi.fn(() => Date.parse("2026-09-07T12:00:00Z"));
  return { fetch, refreshAuth, sleep, random, now,
    request: createUploadRequest({ fetch, refreshAuth, sleep, random, now }),
  };
}

afterEach(() => vi.useRealTimers());

describe("upload HTTP requests", () => {
  it("retains an occupied-path fresh-attempt remedy without replaying the request", async () => {
    const { request, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: { code: "conflict", message: "Start a fresh attempt" },
      new_attempt_required: true }, { status: 409 }));
    await expect(request("original", {})).rejects.toMatchObject({
      code: "conflict", retryable: false, newAttemptRequired: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each(["attempt", "acquire", "claim", "renew", "release", "sidecar", "original", "finalize"])("posts %s to its allowlisted same-origin path", async (operation) => {
    const { request, fetch } = setup();
    const signal = new AbortController().signal;
    await expect(request(operation, { owner_id: "stable-id" }, { signal })).resolves.toEqual({ status: "created" });
    expect(fetch).toHaveBeenCalledWith(operation === "finalize" ? "/api/photos" : `/api/photo-migrations/uploads/${operation}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: '{"owner_id":"stable-id"}', signal,
    });
  });

  it.each(["../admin", "https://external.example", "", "toString"])("rejects unknown operation %j without a request", async (operation) => {
    const { request, fetch } = setup();
    await expect(request(operation, {})).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503, "network"])("caps %s retries at five total requests and four jittered waits", async (status) => {
    const { request, fetch, sleep, refreshAuth } = setup();
    if (typeof status === "number") fetch.mockImplementation(async () => failure(status));
    else fetch.mockRejectedValue(new TypeError("Network disconnected"));
    await expect(request("finalize", { id: "unchanged" })).rejects.toBeInstanceOf(UploadRequestError);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 6000, 12000, 20000]);
    expect(new Set(fetch.mock.calls.map(([, options]) => options!.body)).size).toBe(1);
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it("applies jitter and returns the successful retry result", async () => {
    const { request, fetch, random, sleep } = setup();
    random.mockReturnValue(0.5);
    fetch.mockResolvedValueOnce(failure(503));
    await expect(request("claim", {})).resolves.toEqual({ status: "created" });
    expect(sleep).toHaveBeenCalledWith(1500, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 404, 409, 413, 415])("preserves structured %s errors without automatic retry", async (status) => {
    const { request, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(failure(status));
    await expect(request("attempt", {})).rejects.toMatchObject({
      message: "The upload needs attention", code: "server_code", status, retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives malformed structured errors a useful fallback instead of stringifying objects", async () => {
    const { request, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: { message: { nested: "error" } } }, { status: 403 }));
    await expect(request("claim", {})).rejects.toThrow("Upload request failed (HTTP 403).");
  });

  it("retries non-JSON server failures with the same bounded budget", async () => {
    const { request, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response("temporarily offline", { status: 502 }));
    await expect(request("finalize", {})).resolves.toEqual({ status: "created" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes authentication once and immediately replays the request", async () => {
    const { request, fetch, refreshAuth, sleep } = setup();
    fetch.mockResolvedValueOnce(failure(401));
    await expect(request("renew", {})).resolves.toEqual({ status: "created" });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["failed", "throws", "second-401"])("requires sign-in after auth %s", async (kind) => {
    const { request, fetch, refreshAuth } = setup();
    fetch.mockImplementation(async () => failure(401));
    if (kind === "failed") refreshAuth.mockResolvedValue(false);
    if (kind === "throws") refreshAuth.mockRejectedValue(new Error("refresh unavailable"));
    await expect(request("acquire", {})).rejects.toMatchObject({ code: "unauthenticated", message: "Signed out — sign in and retry" });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(kind === "second-401" ? 2 : 1);
  });

  it("counts the auth replay inside the five-request budget", async () => {
    const { request, fetch, refreshAuth } = setup();
    fetch.mockImplementation(async () => failure(503)).mockResolvedValueOnce(failure(401));
    await expect(request("claim", {})).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(refreshAuth).toHaveBeenCalledOnce();
  });

  it.each(["10", "20", "Mon, 07 Sep 2026 12:00:10 GMT"])("respects short Retry-After %s before replaying", async (retryAfter) => {
    const { request, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(failure(429, retryAfter));
    await request("claim", {});
    expect(sleep).toHaveBeenCalledWith(retryAfter === "20" ? 20000 : 10000, undefined);
  });

  it.each(["21", "Mon, 07 Sep 2026 12:01:00 GMT"])("interrupts long Retry-After %s with the due time, without waiting", async (retryAfter) => {
    const { request, fetch, sleep, now } = setup();
    fetch.mockResolvedValueOnce(failure(429, retryAfter));
    const result = request("claim", {});
    await expect(result).rejects.toMatchObject({
      name: "UploadRequestError", code: "server_code", status: 429, retryable: true,
      retryAt: now() + (retryAfter === "21" ? 21000 : 60000),
    });
    await expect(result).rejects.toThrow("Retry after");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("ignores invalid Retry-After and uses the ordinary jitter delay", async () => {
    const { request, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(failure(503, "not-a-date"));
    await request("claim", {});
    expect(sleep).toHaveBeenCalledWith(3000, undefined);
  });

  it("never starts an already aborted request", async () => {
    const { request, fetch } = setup();
    await expect(request("claim", {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["fetch", "sleep", "refresh"])("cancels pending %s immediately even if an injected dependency does not settle", async (operation) => {
    const { request, fetch, sleep, refreshAuth } = setup();
    const never = () => new Promise<never>(() => {});
    if (operation === "fetch") fetch.mockImplementation(never);
    if (operation === "sleep") { fetch.mockResolvedValueOnce(failure(503)); sleep.mockImplementation(never); }
    if (operation === "refresh") { fetch.mockResolvedValueOnce(failure(401)); refreshAuth.mockImplementation(never); }
    const controller = new AbortController();
    const result = request("finalize", {}, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(operation === "sleep" ? sleep : operation === "refresh" ? refreshAuth : fetch).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the default retry timer without scheduling another request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => failure(503));
    const request = createUploadRequest({ fetch, refreshAuth: async () => true, random: () => 1 });
    const controller = new AbortController();
    const result = request("claim", {}, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
