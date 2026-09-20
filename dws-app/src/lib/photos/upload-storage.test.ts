import { StorageApiError, StorageUnknownError } from "@supabase/storage-js";
import { describe, expect, it, vi } from "vitest";
import type { PhotoStorage } from "./upload";
import { createAbortablePhotoStorage, createRetryingPhotoStorage } from "./upload-storage";
import { UploadRequestError } from "./upload-http";

const FILE = new File(["original bytes"], "site.jpg", { type: "image/jpeg" });
const PATH = "employee/photo/original/site.jpg";

function setup() {
  const upload = vi.fn<PhotoStorage["upload"]>().mockResolvedValue({ error: null });
  const refreshAuth = vi.fn(async () => true);
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
  const now = () => Date.parse("2026-09-07T12:00:00Z");
  return { upload, refreshAuth, sleep, now,
    storage: createRetryingPhotoStorage({ storage: { upload }, refreshAuth, sleep, random: () => 1, now }),
  };
}

describe("standard Storage upload retries", () => {
  it.each([true, false])("preserves the same path, bytes, options, and upsert=%s on retry", async (upsert) => {
    const { storage, upload, sleep } = setup();
    upload.mockResolvedValueOnce({ error: new StorageApiError("Storage busy", 503) });
    const options = { upsert, contentType: FILE.type, signal: new AbortController().signal };
    await expect(storage.upload(PATH, FILE, options)).resolves.toEqual({ error: null });
    expect(upload).toHaveBeenCalledTimes(2);
    for (const [path, body, actualOptions] of upload.mock.calls) {
      expect(path).toBe(PATH);
      expect(body).toBe(FILE);
      expect(actualOptions).toBe(options);
    }
    expect(sleep).toHaveBeenCalledWith(3000, options.signal);
  });

  it.each([
    new StorageApiError("Storage busy", 503),
    { message: "Rate limited", statusCode: "429" },
    new StorageUnknownError("Failed to fetch", new TypeError("network")),
  ])("bounds retries for returned SDK/API errors: %j", async (error) => {
    const { storage, upload, sleep } = setup();
    upload.mockResolvedValue({ error });
    const result = await storage.upload(PATH, FILE);
    expect(result.error).toBeInstanceOf(UploadRequestError);
    expect(result.error).toMatchObject({ message: error.message, retryable: true });
    expect(upload).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3000, 6000, 12000, 20000]);
  });

  it("bounds thrown network failures at five attempts", async () => {
    const { storage, upload } = setup();
    upload.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await storage.upload(PATH, FILE);
    expect(result.error).toMatchObject({ message: "Failed to fetch", retryable: true });
    expect(upload).toHaveBeenCalledTimes(5);
  });

  it.each([
    new StorageApiError("Permission denied", 403),
    new StorageApiError("Object too large", 413),
    new StorageApiError("Unsupported format", 415),
    new StorageApiError("Quota exceeded", 507),
    new StorageApiError("Request failed", 507),
    { message: "Storage quota exceeded", statusCode: "507", code: "quota_exceeded" },
    { message: "Request failed", statusCode: "500", code: "quota_exceeded" },
    { message: "Request failed", statusCode: "500", error: "quota_exceeded" },
    { message: "MIME not supported", statusCode: "500", code: "unsupported_media" },
    { message: "The resource already exists", statusCode: "409" },
    { message: "The resource already exists", statusCode: "400", error: "Duplicate" },
  ])("returns permanent/existing-object failures without retry: %j", async (error) => {
    const { storage, upload, sleep } = setup();
    upload.mockResolvedValue({ error });
    const result = await storage.upload(PATH, FILE, { upsert: false });
    expect(result.error).toMatchObject({ retryable: false });
    if (Number('status' in error ? error.status : error.statusCode) === 507 || ('code' in error && error.code === 'quota_exceeded')) {
      expect(result.error?.message).toContain("administrator");
    } else {
      expect(result.error?.message).toBeTruthy();
    }
    expect(upload).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("refreshes auth once and uses the retry budget for the replay", async () => {
    const { storage, upload, refreshAuth, sleep } = setup();
    upload.mockResolvedValueOnce({ error: new StorageApiError("JWT expired", 401) });
    await expect(storage.upload(PATH, FILE)).resolves.toEqual({ error: null });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["fails", "throws", "second-401"])("requires sign-in when auth refresh %s", async (mode) => {
    const { storage, upload, refreshAuth } = setup();
    upload.mockResolvedValue({ error: { message: "JWT expired", statusCode: "401" } } as Awaited<ReturnType<PhotoStorage["upload"]>>);
    if (mode === "fails") refreshAuth.mockResolvedValue(false);
    if (mode === "throws") refreshAuth.mockRejectedValue(new Error("offline"));
    const result = await storage.upload(PATH, FILE);
    expect(result.error).toMatchObject({ message: "Signed out — sign in and retry", status: 401, retryable: false });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(mode === "second-401" ? 2 : 1);
  });

  it("counts auth refresh replay toward five total Storage attempts", async () => {
    const { storage, upload } = setup();
    upload.mockResolvedValue({ error: new StorageApiError("Busy", 503) })
      .mockResolvedValueOnce({ error: new StorageApiError("Expired", 401) });
    await storage.upload(PATH, FILE);
    expect(upload).toHaveBeenCalledTimes(5);
  });

  it.each(["10", "20", "Mon, 07 Sep 2026 12:00:10 GMT"])("honors available short Retry-After %s", async (retryAfter) => {
    const { storage, upload, sleep } = setup();
    upload.mockResolvedValueOnce({ error: Object.assign(new StorageApiError("Busy", 429), { retryAfter }) });
    await expect(storage.upload(PATH, FILE)).resolves.toEqual({ error: null });
    expect(sleep).toHaveBeenCalledWith(retryAfter === "20" ? 20000 : 10000, undefined);
  });

  it("returns a useful due time for long Retry-After without a timer", async () => {
    const { storage, upload, sleep, now } = setup();
    upload.mockResolvedValueOnce({ error: Object.assign(new StorageApiError("Busy", 503), {
      headers: new Headers({ "Retry-After": "60" }),
    }) });
    const result = await storage.upload(PATH, FILE);
    expect(result.error).toMatchObject({ status: 503, retryAt: now() + 60000, retryable: true });
    expect(result.error?.message).toContain("Retry after 2026-09-07T12:01:00.000Z");
    expect(upload).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cancels before any Storage request starts", async () => {
    const { storage, upload } = setup();
    await expect(storage.upload(PATH, FILE, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(["upload", "sleep", "refresh"])("cancels pending %s without continuing the upload", async (mode) => {
    const { storage, upload, sleep, refreshAuth } = setup();
    const never = () => new Promise<never>(() => {});
    if (mode === "upload") upload.mockImplementation(never);
    if (mode === "sleep") { upload.mockResolvedValue({ error: new StorageApiError("Busy", 503) }); sleep.mockImplementation(never); }
    if (mode === "refresh") { upload.mockResolvedValue({ error: new StorageApiError("Expired", 401) }); refreshAuth.mockImplementation(never); }
    const controller = new AbortController();
    const result = storage.upload(PATH, FILE, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mode === "sleep" ? sleep : mode === "refresh" ? refreshAuth : upload).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(upload).toHaveBeenCalledOnce();
  });
});

describe("actual Supabase SDK Storage adapter with injected network", () => {
  function sdk() {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ Id: "photo", Key: PATH }));
    const getAccessToken = vi.fn(async () => "employee-token");
    const storage = createAbortablePhotoStorage({
      supabaseUrl: "https://isolated.example.invalid", anonKey: "public-anon-key", getAccessToken, fetch,
    });
    return { fetch, getAccessToken, storage };
  }

  it("uses SDK multipart upload, current authorization, and the real AbortSignal", async () => {
    const { storage, fetch, getAccessToken } = sdk();
    const signal = new AbortController().signal;
    await expect(storage.upload(PATH, FILE, { contentType: FILE.type, upsert: true, signal })).resolves.toEqual({ error: null });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`https://isolated.example.invalid/storage/v1/object/photos/${PATH}`);
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(signal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer employee-token");
    expect(headers.get("apikey")).toBe("public-anon-key");
    expect(headers.get("x-upsert")).toBe("true");
    expect(init?.body).toBeInstanceOf(FormData);
    const blob = (init!.body as FormData).get("") as Blob;
    expect(await blob.text()).toBe("original bytes");
    expect(getAccessToken).toHaveBeenCalled();
    getAccessToken.mockResolvedValue("refreshed-token");
    await storage.upload(PATH, FILE, { upsert: false });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer refreshed-token");
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("x-upsert")).toBe("false");
  });

  it("retains actual response status and Retry-After discarded by the SDK", async () => {
    const { storage, fetch } = sdk();
    fetch.mockResolvedValueOnce(Response.json({ statusCode: "429", error: "RateLimit", message: "Slow down" }, {
      status: 429, headers: { "Retry-After": "60" },
    }));
    await expect(storage.upload(PATH, FILE)).resolves.toMatchObject({ error: {
      status: 429, statusCode: "429", message: "Slow down", retryAfter: "60",
    } });
  });

  it("aborts the actual fetch signal and settles immediately", async () => {
    const { storage, fetch } = sdk();
    let observedSignal: AbortSignal | null | undefined;
    fetch.mockImplementation((_url, init) => {
      observedSignal = init?.signal;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    const controller = new AbortController();
    const result = storage.upload(PATH, FILE, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("wires actual SDK errors through the shared retry/auth policy", async () => {
    const { storage: raw, fetch, getAccessToken } = sdk();
    fetch.mockResolvedValueOnce(Response.json({ message: "JWT expired", statusCode: "401" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ message: "Busy", statusCode: "503" }, { status: 503, headers: { "Retry-After": "10" } }));
    const refreshAuth = vi.fn(async () => { getAccessToken.mockResolvedValue("refreshed-token"); return true; });
    const sleep = vi.fn(async (_ms: number) => {});
    const storage = createRetryingPhotoStorage({ storage: raw, refreshAuth, sleep, random: () => 0 });
    await expect(storage.upload(PATH, FILE)).resolves.toEqual({ error: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10000, undefined);
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get("Authorization")).toBe("Bearer refreshed-token");
  });
});
