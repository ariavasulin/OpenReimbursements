import { afterEach, describe, expect, it, vi } from "vitest";
import { Upload as ActualTusUpload, type DetailedError, type HttpRequest, type UploadOptions } from "tus-js-client";
import { createResumableUpload, RESUMABLE_THRESHOLD_BYTES, TUS_CHUNK_BYTES, type TusUploadCtor } from "./upload-tus";
import { uploadOne } from "./upload";
import { makeDeps, makeFile, META } from "./__fixtures__/upload";

describe("createResumableUpload", () => {
  // Fake tus Upload that "sends" the file in chunkSize slices, invoking
  // onBeforeRequest before every request the way the real client does —
  // which is exactly where the token refresh must happen.
  class FakeTusUpload {
    static instances: FakeTusUpload[] = [];
    previousUploads: unknown[] = [];
    resumedFrom: unknown = null;
    started = false;
    aborted = false;
    async abort() { this.aborted = true; }

    constructor(
      public file: File,
      public options: UploadOptions
    ) {
      FakeTusUpload.instances.push(this);
    }

    async findPreviousUploads() {
      return this.previousUploads;
    }

    resumeFromPreviousUpload(previous: unknown) {
      this.resumedFrom = previous;
    }

    start() {
      this.started = true;
      void (async () => {
        const total = this.file.size;
        const chunk = this.options.chunkSize ?? total;
        try {
          for (let sent = 0; sent < total; sent += chunk) {
            const request = {
              setHeader: (name: string, value: string) =>
                FakeTusUpload.headers.push([name, value]),
            } as unknown as HttpRequest;
            await this.options.onBeforeRequest?.(request);
            this.options.onProgress?.(Math.min(sent + chunk, total), total);
          }
          this.options.onSuccess?.({ lastResponse: null } as never);
        } catch (error) {
          this.options.onError?.(error as Error);
        }
      })();
    }

    static headers: [string, string][] = [];
    static reset() {
      FakeTusUpload.instances = [];
      FakeTusUpload.headers = [];
    }
  }

  const CONFIG = {
    supabaseUrl: "https://example.supabase.co",
    refreshAuth: async () => true,
    UploadCtor: FakeTusUpload as unknown as TusUploadCtor,
  };

  function bigFile(chunks: number): File {
    return makeFile("big.mp4", "video/mp4", TUS_CHUNK_BYTES * chunks);
  }

  it("configures Supabase's TUS contract: endpoint, EXACT 6 MB chunks, metadata, x-upsert", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => "token-1",
    });

    const result = await upload("originals/u1/p1/big.mp4", bigFile(1), {
      contentType: "video/mp4",
    });

    expect(result.error).toBeNull();
    const options = FakeTusUpload.instances[0].options;
    expect(options.endpoint).toBe(
      "https://example.supabase.co/storage/v1/upload/resumable"
    );
    expect(options.chunkSize).toBe(6 * 1024 * 1024);
    expect(options.metadata).toEqual({
      bucketName: "photos",
      objectName: "originals/u1/p1/big.mp4",
      contentType: "video/mp4",
      cacheControl: "3600",
    });
    expect(options.headers).toMatchObject({ "x-upsert": "true" });
    expect(options.removeFingerprintOnSuccess).toBe(true);
  });

  it("refreshes the access token between chunks (expiring mid-upload can't 401 it)", async () => {
    FakeTusUpload.reset();
    let tokenCounter = 0;
    const getAccessToken = vi.fn(async () => `token-${++tokenCounter}`);
    const upload = createResumableUpload({ ...CONFIG, getAccessToken });

    const result = await upload("originals/u1/p1/big.mp4", bigFile(3), {
      contentType: "video/mp4",
    });

    expect(result.error).toBeNull();
    // One fresh token per chunk request — not one token for the whole upload.
    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(FakeTusUpload.headers).toEqual([
      ["Authorization", "Bearer token-1"],
      ["Authorization", "Bearer token-2"],
      ["Authorization", "Bearer token-3"],
    ]);
  });

  it("reports chunk progress", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => "token",
    });
    const ticks: [number, number][] = [];

    await upload("originals/u1/p1/big.mp4", bigFile(2), {
      contentType: "video/mp4",
      onProgress: (sent, total) => ticks.push([sent, total]),
    });

    expect(ticks).toEqual([
      [TUS_CHUNK_BYTES, TUS_CHUNK_BYTES * 2],
      [TUS_CHUNK_BYTES * 2, TUS_CHUNK_BYTES * 2],
    ]);
  });

  it("scopes the resume fingerprint to the objectName — a retry's NEW photoId path never matches an old attempt", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => "token",
    });
    const file = bigFile(1);

    await upload("originals/u1/old-id/big.mp4", file, {
      contentType: "video/mp4",
    });
    await upload("originals/u1/new-id/big.mp4", file, {
      contentType: "video/mp4",
    });

    const [first, second] = FakeTusUpload.instances;
    const firstFingerprint = await first.options.fingerprint!(
      file,
      first.options
    );
    const secondFingerprint = await second.options.fingerprint!(
      file,
      second.options
    );
    expect(firstFingerprint).not.toBe(secondFingerprint);
    expect(
      await first.options.fingerprint!(file, first.options)
    ).toBe(firstFingerprint);
  });

  it("resumes a previous upload of the same file when one exists", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => "token",
      UploadCtor: class extends FakeTusUpload {
        constructor(file: File, options: UploadOptions) {
          super(file, options);
          this.previousUploads = [{ urlStorageKey: "prior" }];
        }
      } as unknown as TusUploadCtor,
    });

    await upload("originals/u1/p1/big.mp4", bigFile(1), {
      contentType: "video/mp4",
    });

    const instance = FakeTusUpload.instances[0];
    expect(instance.resumedFrom).toEqual({ urlStorageKey: "prior" });
    expect(instance.started).toBe(true);
  });

  it("resolves an error result (never throws) when tus errors", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => null, // signed out -> onBeforeRequest throws
    });

    const result = await upload("originals/u1/p1/big.mp4", bigFile(1), {
      contentType: "video/mp4",
    });

    expect(result.error?.message).toContain("Signed out");
  });

  it("aborts TUS without terminating the resumable resource and never starts after pending lookup", async () => {
    FakeTusUpload.reset();
    const controller = new AbortController();
    let finishLookup!: (value: unknown[]) => void;
    const abort = vi.fn(async () => undefined);
    const upload = createResumableUpload({
      ...CONFIG, getAccessToken: async () => "token",
      UploadCtor: class extends FakeTusUpload {
        abort = abort;
        findPreviousUploads() { return new Promise<unknown[]>((resolve) => { finishLookup = resolve; }); }
      } as unknown as TusUploadCtor,
    });
    const pending = upload("originals/u1/p1/big.mp4", bigFile(1), { contentType: "video/mp4", signal: controller.signal });
    controller.abort();
    expect((await pending).error?.message).toContain("cancelled");
    expect(abort).toHaveBeenCalledWith(false);
    finishLookup([]);
    await Promise.resolve();
    expect(FakeTusUpload.instances[0].started).toBe(false);
  });

  it("supports no-overwrite TUS for sidecar repair", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({ ...CONFIG, getAccessToken: async () => "token" });
    await upload("originals/u1/p1/big.xmp", bigFile(1), { contentType: "application/rdf+xml", upsert: false });
    expect(FakeTusUpload.instances[0].options.headers).toEqual({ "x-upsert": "false" });
  });

  it("retries connection drops, 5xx, and 401 — not other 4xx", async () => {
    FakeTusUpload.reset();
    const upload = createResumableUpload({
      ...CONFIG,
      getAccessToken: async () => "token",
    });
    await upload("originals/u1/p1/big.mp4", bigFile(1), {
      contentType: "video/mp4",
    });
    const opts = FakeTusUpload.instances[0].options;
    const { onShouldRetry } = opts;

    const errorWithStatus = (status: number | null) =>
      (status === null
        ? new Error("network down")
        : {
            originalResponse: { getStatus: () => status, getHeader: () => undefined },
          }) as unknown as DetailedError;

    expect(onShouldRetry?.(errorWithStatus(null), 0, opts)).toBe(true); // connection
    expect(onShouldRetry?.(errorWithStatus(500), 0, opts)).toBe(true);
    expect(onShouldRetry?.(errorWithStatus(401), 0, opts)).toBe(true); // token refreshed next try
    expect(onShouldRetry?.(errorWithStatus(403), 0, opts)).toBe(false);
    expect(onShouldRetry?.(errorWithStatus(413), 0, opts)).toBe(false);
  });
});

describe("TUS retry policy through the real client's HTTP pipeline", () => {
  afterEach(() => vi.useRealTimers());
  type Reply = { status?: number; retryAfter?: string; networkError?: boolean; body?: string };
  function harness(replies: Reply[], opts: {
    resume?: boolean; random?: () => number; refreshAuth?: () => Promise<boolean>;
  } = {}) {
    const requests: { method: string; time: number; authorization?: string }[] = [];
    let refreshed = false;
    const refreshAuth = vi.fn(opts.refreshAuth ?? (async () => { refreshed = true; return true; }));
    const file = makeFile("a.jpg", "image/jpeg", 4);
    const upload = createResumableUpload({
      supabaseUrl: "https://example.supabase.co", refreshAuth,
      getAccessToken: async () => refreshed ? "new-token" : "old-token",
      random: opts.random ?? (() => 0),
      UploadCtor: class extends ActualTusUpload {
        constructor(input: File, options: UploadOptions) {
          super(input, {
            ...options,
            uploadUrl: opts.resume ? "https://example.supabase.co/resource" : null,
            fileReader: {
              openFile: async () => ({ size: input.size, close() {},
                slice: async (start, end) => ({ value: input.slice(start, end), done: end >= input.size }) }),
            },
            urlStorage: {
              findAllUploads: async () => [], findUploadsByFingerprint: async () => [],
              addUpload: async () => "fingerprint-key", removeUpload: async () => undefined,
            },
            httpStack: {
              getName: () => "test-http",
              createRequest: (method, url) => {
                const headers: Record<string, string> = {};
                return {
                  getMethod: () => method, getURL: () => url,
                  setHeader: (key, value) => { headers[key] = value; },
                  getHeader: (key) => headers[key], setProgressHandler() {},
                  abort: async () => undefined, getUnderlyingObject: () => null,
                  send: async () => {
                    requests.push({ method, time: Date.now(), authorization: headers.Authorization });
                    const reply = replies.shift() ?? {};
                    if (reply.networkError) throw new Error("connection dropped");
                    return {
                      getStatus: () => reply.status ?? (method === "POST" ? 201 : 200),
                      getHeader: (key) => ({
                        "retry-after": reply.retryAfter, location: "/resource",
                        "upload-offset": String(file.size), "upload-length": String(file.size),
                      })[key.toLowerCase()],
                      getBody: () => reply.body ?? "", getUnderlyingObject: () => null,
                    };
                  },
                };
              },
            },
          });
        }
      } as unknown as TusUploadCtor,
    });
    return { upload, file, requests, refreshAuth };
  }

  it("honors short Retry-After as a minimum over jitter for resumed HEAD requests", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { upload, file, requests } = harness([{ status: 429, retryAfter: "2" }, {}], { resume: true, random: () => 0.5 });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).error).toBeNull();
    expect(requests.map((request) => [request.method, request.time])).toEqual([["HEAD", 0], ["HEAD", 2000]]);
  });

  it.each(["60", "Thu, 01 Jan 1970 00:01:00 GMT"])("interrupts immediately on long Retry-After %s with a retry timestamp", async (retryAfter) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { upload, file, requests } = harness([{ status: 429, retryAfter }], { resume: true });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).error).toMatchObject({ status: 429, retryable: true, retryAt: 60_000, message: expect.stringContaining("Retry after") });
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ networkError: true }, { status: 500 }, { status: 429 }])("limits %j to five total attempts with capped jitter", async (failure) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { upload, file, requests } = harness(Array.from({ length: 6 }, () => failure), { random: () => 0.5 });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error?.retryable).toBe(true);
    expect(requests.map((request) => request.time)).toEqual([0, 1500, 4500, 10500, 20500]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes auth once before sending a resumed request after401", async () => {
    vi.useFakeTimers();
    const { upload, file, requests, refreshAuth } = harness([{ status: 401 }, {}], { resume: true });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toBeNull();
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(requests.map((request) => [request.method, request.authorization])).toEqual([["HEAD", "Bearer old-token"], ["HEAD", "Bearer new-token"]]);
  });

  it.each(["second401", "refreshFailed", "refreshThrows"])("stops authentication retries on %s", async (scenario) => {
    vi.useFakeTimers();
    const refreshAuth = scenario === "refreshFailed" ? async () => false
      : scenario === "refreshThrows" ? async () => { throw new Error("refresh unavailable"); } : undefined;
    const { upload, file, requests, refreshAuth: refresh } = harness([{ status: 401 }, { status: 401 }], { refreshAuth });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toMatchObject({ status: 401, retryable: false, message: expect.stringContaining("Signed out") });
    expect(refresh).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(scenario === "second401" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([403, 413, 415, 422])("never retries or recreates a resumed upload on HTTP%s", async (status) => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{ status }], { resume: true });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toMatchObject({ status, retryable: false });
    expect(requests.map((request) => request.method)).toEqual(["HEAD"]);
  });

  it.each([false, true])("treats HTTP507 as permanent insufficient Storage capacity (resume=%s)", async (resume) => {
    vi.useFakeTimers();
    const { upload, file, requests, refreshAuth } = harness([{ status: 507, retryAfter: "10" }], { resume });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).error).toMatchObject({
      status: 507, retryable: false,
      message: expect.stringContaining("Ask an administrator"),
    });
    expect(requests.map((request) => request.method)).toEqual([resume ? "HEAD" : "POST"]);
    expect(refreshAuth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])("never retries quota-coded HTTP500 from real response JSON (resume=%s)", async (resume) => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{
      status: 500, retryAfter: "10", body: JSON.stringify({ code: "quota_exceeded", message: "Request failed" }),
    }], { resume });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).error).toMatchObject({
      status: 500, code: "quota_exceeded", retryable: false,
      message: expect.stringContaining("Ask an administrator"),
    });
    expect(requests.map((request) => request.method)).toEqual([resume ? "HEAD" : "POST"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("safely retries a non-JSON proxy failure", async () => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{ status: 502, body: "<html>Bad gateway</html>" }, {}]);
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("preserves the permanent capacity remedy in the orchestrator's final result", async () => {
    vi.useFakeTimers();
    const { upload, requests } = harness([{ status: 507 }]);
    const { deps } = makeDeps();
    deps.hash = vi.fn(async () => "a".repeat(64));
    deps.resumableUpload = upload;
    const pending = uploadOne(makeFile("a.jpg", "image/jpeg", RESUMABLE_THRESHOLD_BYTES + 1), "photo-1", META, deps);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      status: "failed", retryable: false,
      error: expect.stringContaining("Ask an administrator"),
    });
    expect(requests).toHaveLength(1);
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([404, 410])("recreates a missing TUS resource after HEAD HTTP%s", async (status) => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{ status }, {}], { resume: true });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["HEAD", "POST"]);
  });
  it.each([409, 423])("retains bounded retry for transient Storage lock HTTP%s", async (status) => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{ status }, {}], { resume: true });
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type });
    await vi.runAllTimersAsync();
    expect((await pending).error).toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["HEAD", "HEAD"]);
  });

  it("aborts the real TUS retry timer without any new request", async () => {
    vi.useFakeTimers();
    const { upload, file, requests } = harness([{ status: 429, retryAfter: "10" }, {}]);
    const controller = new AbortController();
    const pending = upload("originals/u/p/a.jpg", file, { contentType: file.type, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect((await pending).error?.message).toContain("cancelled");
    await vi.runAllTimersAsync();
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

