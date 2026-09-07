import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Upload as ActualTusUpload } from "tus-js-client";
import { UploadRequestError } from "./upload-http";
import type {
  DetailedError,
  HttpRequest,
  UploadOptions,
} from "tus-js-client";
import {
  createResumableUpload,
  RESUMABLE_THRESHOLD_BYTES,
  sanitizeFilename,
  storagePaths,
  TUS_CHUNK_BYTES,
  METADATA_MAX_BYTES, DERIVATIVES_MAX_BYTES, SIDECAR_METADATA_MAX_BYTES, LEASE_RENEW_MS,
  type UploadIdentity,
  uploadOne, retrySidecar,
  type FinalizePayload,
  type TusUploadCtor,
  type UploadDeps,
  type UploadMeta,
} from "./upload";
import { createHash } from "node:crypto";
import type { CanonicalUploadOutcome } from "./upload-contract";
const sha256 = async (file: File) => createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");

const META: UploadMeta = {
  jobId: "0b7f0000-0000-4000-8000-000000000001",
  uploaderId: "user-1",
  sheetNumber: "12",
  tags: ["professional"],
};

const CAPTURED = new Date("2026-08-14T14:41:00.000Z");

interface Recorded {
  path: string;
  contentType?: string;
  bytes: number;
}

function makeDeps(overrides?: {
  failUploadPaths?: (path: string) => boolean;
  /** Simulate the tab dying mid-step: throws at matching storage paths, or at
   * "finalize" for the row POST. */
  throwAt?: (path: string) => boolean;
  failFinalize?: boolean;
  noDerivatives?: boolean;
}) {
  const uploads: Recorded[] = [];
  const finalized: FinalizePayload[] = [];

  const deps: UploadDeps = {
    hash: vi.fn(sha256),
    createAttempt: vi.fn(async (input) => {
      const paths = storagePaths(META.uploaderId, input.photo_id, input.original_name);
      return { owner_kind: "ordinary" as const, owner_id: input.attempt_id,
        photo_id: input.photo_id, job_id: input.job_id, content_sha256: input.content_sha256,
        original_path: paths.original, thumb_path: paths.thumb, preview_path: paths.preview,
        sidecar_path: paths.sidecar, result: null };
    }),
    acquireLease: vi.fn(async () => ({ status: "acquired" as const, lease_generation: 1, lease_expires_at: "2026-09-07T00:02:00Z" })),
    claimContent: vi.fn(async () => ({ status: "claimed" as const, claim_generation: 2, lease_expires_at: "2026-09-07T00:02:00Z" })),
    attachSidecar: vi.fn(async () => ({ status: "created" as const, photo_id: "photo-1", job_id: META.jobId, sidecar_retry: false })),
    probeOriginal: vi.fn(async () => ({ complete: false })),
    renewLease: vi.fn(async () => undefined),
    releaseLease: vi.fn(async () => undefined),
    resumableUpload: vi.fn(async () => ({ error: null })),
    storage: {
      async upload(path, body, options) {
        if (overrides?.throwAt?.(path)) throw new Error("KILLED");
        if (overrides?.failUploadPaths?.(path)) {
          return { error: { message: `refused ${path}` } };
        }
        uploads.push({
          path,
          contentType: options?.contentType,
          bytes: body.size,
        });
        return { error: null };
      },
    },
    finalize: vi.fn(async (payload: FinalizePayload) => {
      if (overrides?.throwAt?.("finalize")) throw new Error("KILLED");
      if (overrides?.failFinalize) throw new Error("db says no");
      finalized.push(payload);
      return { status: "created" as const, photo_id: payload.id, job_id: payload.job_id };
    }),
    extractCapturedAt: async (_file, opts) =>
      opts?.shutter
        ? { date: opts.shutter, source: "camera" }
        : { date: CAPTURED, source: "exif" },
    makeDerivatives: async () =>
      overrides?.noDerivatives
        ? null
        : {
            thumb: new Blob(["t"], { type: "image/webp" }),
            preview: new Blob(["p"], { type: "image/webp" }),
            durationSecs: null,
          },
  };

  return { deps, uploads, finalized };
}

function makeFile(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 0 });
}

describe("uploadOne", () => {
  it("uploads the original FIRST, then derivatives, then POSTs the row", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const file = makeFile("IMG_0001.jpg", "image/jpeg", 10);

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(uploads.map((u) => u.path)).toEqual([
      "originals/user-1/photo-1/IMG_0001.jpg",
      "derived/user-1/photo-1_thumb.webp",
      "derived/user-1/photo-1_preview.webp",
    ]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      id: "photo-1",
      job_id: META.jobId,
      kind: "image",
      sheet_number: "12",
      tags: ["professional"],
      captured_at: CAPTURED.toISOString(),
      captured_at_source: "exif",
      original_path: "originals/user-1/photo-1/IMG_0001.jpg",
      original_bytes: 10,
      mime_type: "image/jpeg",
      original_name: "IMG_0001.jpg",
      thumb_path: "derived/user-1/photo-1_thumb.webp",
      preview_path: "derived/user-1/photo-1_preview.webp",
    });
  });

  it("treats a created finalize replay as done", async () => {
    const { deps } = makeDeps();
    deps.finalize = vi.fn(async () => ({ status: "created" as const, photo_id: "photo-1", job_id: META.jobId }));

    const result = await uploadOne(
      makeFile("a.jpg", "image/jpeg"),
      "photo-1",
      META,
      deps
    );

    expect(result).toMatchObject({ status: "done" });
  });

  it("marks the file failed when the row POST fails", async () => {
    const { deps, finalized } = makeDeps({ failFinalize: true });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("db says no");
    expect(finalized).toHaveLength(0);
  });

  it("fails without finalizing when the ORIGINAL upload fails", async () => {
    const { deps, uploads } = makeDeps({
      failUploadPaths: (path) => path.startsWith("originals/"),
    });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);

    expect(result.status).toBe("failed");
    expect(uploads).toHaveLength(0); // derivatives never went up either
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("still lands the row (null derivative paths) when a derivative upload fails", async () => {
    const { deps, finalized } = makeDeps({
      failUploadPaths: (path) => path.includes("_thumb"),
    });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(finalized[0].thumb_path).toBeNull();
    expect(finalized[0].preview_path).toBe("derived/user-1/photo-1_preview.webp");
  });

  it("handles undecodable files: no derivatives, row lands with nulls", async () => {
    const { deps, uploads, finalized } = makeDeps({ noDerivatives: true });
    const file = makeFile("shot.CR3", "", 6);

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(uploads).toHaveLength(1); // only the original
    expect(finalized[0]).toMatchObject({
      kind: "file",
      mime_type: "application/octet-stream", // canonical, never the browser's blank
      thumb_path: null,
      preview_path: null,
    });
  });

  it("classifies by extension: a typeless .mov is a video with a canonical mime", async () => {
    const { deps, uploads, finalized } = makeDeps({ noDerivatives: true });
    const file = makeFile("IMG_5011.MOV", "", 8); // Safari sometimes leaves type empty

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("done");
    // The stored object carries the canonical Content-Type (rewrap), not "".
    expect(uploads[0].contentType).toBe("video/quicktime");
    expect(finalized[0]).toMatchObject({
      kind: "video",
      mime_type: "video/quicktime",
    });
  });

  it("forwards the shutter time so in-app shots record source 'camera'", async () => {
    const { deps, finalized } = makeDeps();
    const shutter = new Date("2026-08-20T10:00:00.000Z");

    const result = await uploadOne(
      makeFile("a.jpg", "image/jpeg"),
      "photo-1",
      META,
      deps,
      undefined,
      { shutter }
    );

    expect(result.status).toBe("done");
    expect(finalized[0]).toMatchObject({
      captured_at: shutter.toISOString(),
      captured_at_source: "camera",
    });
  });

  it("finalizes source 'upload' with a null date when extraction throws", async () => {
    const { deps, finalized } = makeDeps();
    deps.extractCapturedAt = async () => {
      throw new Error("exif exploded");
    };

    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(finalized[0]).toMatchObject({
      captured_at: null,
      captured_at_source: "upload",
    });
  });
});

describe("uploadOne with a sidecar", () => {
  const XMP = readFileSync(join(__dirname, "__fixtures__", "sample.xmp"));
  const xmpFile = (name = "IMG_0001.xmp") => new File([XMP], name);
  // The fixture's exif:DateTimeOriginal carries no offset -> local time.
  const FIXTURE_CAPTURED = new Date("2026-08-14T14:41:00");

  it("uploads the sidecar AFTER the original and BEFORE derivatives, and finalizes both columns", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const file = makeFile("IMG_0001.jpg", "image/jpeg", 10);

    const result = await uploadOne(file, "photo-1", META, deps, undefined, {
      sidecar: xmpFile(),
    });

    expect(result.status).toBe("done");
    expect(uploads.map((u) => u.path)).toEqual([
      "originals/user-1/photo-1/IMG_0001.jpg",
      "originals/user-1/photo-1/IMG_0001.xmp",
      "derived/user-1/photo-1_thumb.webp",
      "derived/user-1/photo-1_preview.webp",
    ]);
    expect(uploads[1].contentType).toBe("application/rdf+xml");
    expect(finalized[0]).toMatchObject({
      sidecar_path: "originals/user-1/photo-1/IMG_0001.xmp",
      sidecar_name: "IMG_0001.xmp",
    });
  });

  it("still lands the row (null sidecar columns) when the sidecar upload fails", async () => {
    const { deps, finalized } = makeDeps({
      failUploadPaths: (path) => path.endsWith(".xmp"),
    });

    const result = await uploadOne(
      makeFile("a.jpg", "image/jpeg"),
      "photo-1",
      META,
      deps,
      undefined,
      { sidecar: xmpFile("a.xmp") }
    );

    expect(result.status).toBe("done");
    expect(finalized[0]).toMatchObject({
      sidecar_path: null,
      sidecar_name: null,
    });
  });

  it("feeds the sidecar's XMP date into extractCapturedAt (source 'xmp' when no EXIF)", async () => {
    const { deps, finalized } = makeDeps();
    deps.extractCapturedAt = async (_file, opts) =>
      opts?.sidecarDate
        ? { date: opts.sidecarDate, source: "xmp" }
        : { date: null, source: "upload" };

    const result = await uploadOne(
      makeFile("a.jpg", "image/jpeg"),
      "photo-1",
      META,
      deps,
      undefined,
      { sidecar: xmpFile("a.xmp") }
    );

    expect(result.status).toBe("done");
    expect(finalized[0]).toMatchObject({
      captured_at: FIXTURE_CAPTURED.toISOString(),
      captured_at_source: "xmp",
    });
  });

  it("finalizes without sidecar columns when none is passed", async () => {
    const { deps, finalized } = makeDeps();
    await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);
    expect(finalized[0]).toMatchObject({
      sidecar_path: null,
      sidecar_name: null,
    });
  });
});

describe("canonical hash/attempt/claim/finalize contract", () => {
  const outcomes: [CanonicalUploadOutcome, string][] = [
    [{ status: "created" as const, photo_id: "canonical", job_id: META.jobId }, "done"],
    [{ status: "duplicate_active", photo_id: "canonical", job_id: META.jobId }, "duplicate"],
    [{ status: "duplicate_active", photo_id: "canonical", job_id: "other-job" }, "job_conflict"],
    [{ status: "duplicate_trashed", photo_id: "canonical", job_id: META.jobId, purge_after: "2026-10-01" }, "restore_required"],
    [{ status: "duplicate_trashed", photo_id: "canonical", job_id: "other-job", purge_after: "2026-10-01" }, "restore_required"],
  ];
  it.each(outcomes)("maps preflight %j to %s without bytes for either size", async (outcome, status) => {
    for (const size of [10, RESUMABLE_THRESHOLD_BYTES + 1]) {
      const { deps, uploads } = makeDeps();
      deps.claimContent = vi.fn(async () => outcome);
      const result = await uploadOne(makeFile("a.jpg", "image/jpeg", size), "photo-1", META, deps);
      expect(result).toMatchObject({ status, canonicalPhotoId: "canonical", canonicalJobId: outcome.job_id });
      expect(uploads).toEqual([]);
      expect(deps.resumableUpload).not.toHaveBeenCalled();
      expect(deps.finalize).not.toHaveBeenCalled();
    }
  });
  it.each(outcomes)("maps late finalize %j to %s without browser cleanup", async (outcome, status) => {
    const { deps, uploads } = makeDeps();
    const remove = vi.fn();
    Object.assign(deps.storage, { remove });
    deps.finalize = vi.fn(async () => outcome);
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);
    expect(result.status).toBe(status);
    expect(uploads).toHaveLength(3);
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["hash", "createAttempt", "acquireLease", "claimContent", "probeOriginal"] as const)("sends no bytes when %s fails", async (step) => {
    const { deps, uploads } = makeDeps();
    deps[step] = vi.fn(async () => { throw new Error(`${step} unavailable`); });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps);
    expect(result).toMatchObject({ status: "failed", error: `${step} unavailable` });
    expect(uploads).toEqual([]);
    expect(deps.resumableUpload).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
  it.each(["", "ABC", null])("refuses invalid hash %s without an attempt", async (digest) => {
    const { deps, uploads } = makeDeps();
    deps.hash = vi.fn(async () => digest as string);
    expect((await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps)).status).toBe("failed");
    expect(uploads).toEqual([]);
    expect(deps.createAttempt).not.toHaveBeenCalled();
  });
  it("waits on a contended claim without bytes and releases its owner lease", async () => {
    const { deps, uploads } = makeDeps();
    deps.claimContent = vi.fn(async () => ({ status: "waiting_claim" as const, lease_expires_at: "2026-09-07T00:02:00Z" }));
    expect((await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps)).status).toBe("waiting_claim");
    expect(uploads).toEqual([]);
    expect(deps.releaseLease).toHaveBeenCalledWith({ owner_kind: "ordinary" as const, owner_id: "photo-1", lease_generation: 1, status: "retryable_failed" });
  });
  it("uses server-returned paths/photo identity and carries required hash and lease generations", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const baseCreate = deps.createAttempt;
    deps.createAttempt = vi.fn(async (input) => ({ ...(await baseCreate(input)), photo_id: "server-photo", original_path: "server-original", thumb_path: "server-thumb", preview_path: "server-preview" }));
    const file = makeFile("a.jpg", "image/jpeg", 10);
    await uploadOne(file, "local-photo", META, deps);
    expect(uploads.map((entry) => entry.path)).toEqual(["server-original", "server-thumb", "server-preview"]);
    expect(finalized[0]).toMatchObject({ id: "server-photo", content_sha256: await sha256(file), owner_id: "local-photo", lease_generation: 1, claim_generation: 2, warnings: [] });
  });
});

describe("resumable (TUS) routing in uploadOne", () => {
  const bigSize = RESUMABLE_THRESHOLD_BYTES + 1;

  function withResumable(overrides?: { failResumable?: boolean }) {
    const base = makeDeps();
    const resumableCalls: { path: string; size: number }[] = [];
    const deps: UploadDeps = {
      ...base.deps,
      resumableUpload: vi.fn(async (path, file, options) => {
        resumableCalls.push({ path, size: file.size });
        if (overrides?.failResumable) {
          return { error: { message: "tus gave up" } };
        }
        options.onProgress?.(TUS_CHUNK_BYTES, file.size);
        options.onProgress?.(file.size, file.size);
        return { error: null };
      }),
    };
    return { ...base, deps, resumableCalls };
  }

  it("sends originals over the 6 MB threshold via TUS, derivatives plain", async () => {
    const { deps, uploads, finalized, resumableCalls } = withResumable();
    const file = makeFile("big.mp4", "video/mp4", bigSize);

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(resumableCalls).toEqual([
      { path: "originals/user-1/photo-1/big.mp4", size: bigSize },
    ]);
    // The plain-upload path carried ONLY the two derivatives.
    expect(uploads.map((u) => u.path)).toEqual([
      "derived/user-1/photo-1_thumb.webp",
      "derived/user-1/photo-1_preview.webp",
    ]);
    expect(finalized[0].original_path).toBe(
      "originals/user-1/photo-1/big.mp4"
    );
  });

  it("keeps files at or under the threshold on the plain path", async () => {
    const { deps, uploads, resumableCalls } = withResumable();
    const file = makeFile("small.jpg", "image/jpeg", RESUMABLE_THRESHOLD_BYTES);

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("done");
    expect(resumableCalls).toHaveLength(0);
    expect(uploads[0].path).toBe("originals/user-1/photo-1/small.jpg");
  });

  it("reports byte progress from TUS and a final size/size tick", async () => {
    const { deps } = withResumable();
    const file = makeFile("big.mp4", "video/mp4", bigSize);
    const ticks: [number, number][] = [];

    await uploadOne(file, "photo-1", META, deps, (sent, total) =>
      ticks.push([sent, total])
    );

    expect(ticks.at(-1)).toEqual([bigSize, bigSize]);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i][0]).toBeGreaterThanOrEqual(ticks[i - 1][0]);
    }
  });

  it("fails (no finalize) when the TUS upload errors out", async () => {
    const { deps, finalized } = withResumable({ failResumable: true });
    const file = makeFile("big.mp4", "video/mp4", bigSize);

    const result = await uploadOne(file, "photo-1", META, deps);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("tus gave up");
    expect(finalized).toHaveLength(0);
    expect(deps.finalize).not.toHaveBeenCalled();
  });
});

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

describe("step-kill convergence", () => {
  // Simulate the tab dying at each step of uploadOne and assert every
  // partial state is repairable: derivatives never exist without their
  // original, a row never exists without its original, and a retry (SAME
  // photoId — the manager keeps it stable) converges to a complete photo.
  // Leftover row-less objects are exactly what the repair cron's orphan
  // sweep deletes.
  type KillPoint = "original" | "thumb" | "preview" | "finalize";

  const stepFor = (path: string): KillPoint =>
    path === "finalize"
      ? "finalize"
      : path.startsWith("originals/")
        ? "original"
        : path.includes("_thumb")
          ? "thumb"
          : "preview";

  const expectRepairableState = (
    uploads: Recorded[],
    rows: FinalizePayload[]
  ) => {
    const objects = new Set(uploads.map((upload) => upload.path));
    const originals = [...objects].filter((path) =>
      path.startsWith("originals/")
    );
    const derived = [...objects].filter((path) => path.startsWith("derived/"));
    // Derivatives only ever exist alongside their original (original FIRST).
    for (const path of derived) {
      const photoId = path.match(/derived\/[^/]+\/(.+)_(thumb|preview)/)?.[1];
      expect(
        originals.some((original) => original.includes(`/${photoId}/`))
      ).toBe(true);
    }
    // A row only ever points at objects that are really in storage.
    for (const row of rows) {
      expect(objects.has(row.original_path)).toBe(true);
      if (row.thumb_path) expect(objects.has(row.thumb_path)).toBe(true);
      if (row.preview_path) expect(objects.has(row.preview_path)).toBe(true);
    }
  };

  it.each<KillPoint>(["original", "finalize"])(
    "a kill at %s leaves a repairable state, and a retry converges",
    async (killPoint) => {
      const kill = { at: killPoint as KillPoint | null };
      const { deps, uploads, finalized: rows } = makeDeps({
        throwAt: (path) => kill.at === stepFor(path),
      });
      const file = makeFile("IMG_0042.jpg", "image/jpeg", 10);

      const killed = await uploadOne(file, "photo-1", META, deps);

      expect(killed.status).toBe("failed");
      expect(rows).toHaveLength(0); // no kill point leaves a phantom row
      expectRepairableState(uploads, rows);

      // The user taps Retry (network is back): the file converges.
      kill.at = null;
      const retried = await uploadOne(file, "photo-1", META, deps);

      expect(retried.status).toBe("done");
      expect(rows).toHaveLength(1);
      expect(rows[0].thumb_path).not.toBeNull();
      expectRepairableState(uploads, rows);
    }
  );
});

describe("sanitizeFilename", () => {
  it("scrubs spaces, punctuation, and non-ASCII but keeps the extension", () => {
    expect(sanitizeFilename("My Photo #1 (edit).jpg")).toBe(
      "My_Photo_1_edit.jpg"
    );
    expect(sanitizeFilename("фото.jpg")).toBe("file.jpg");
    expect(sanitizeFilename("plain.HEIC")).toBe("plain.HEIC");
    expect(sanitizeFilename("no-extension")).toBe("no-extension");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
  });
});

describe("storagePaths", () => {
  it("builds own-prefix keys, the sidecar named after the original", () => {
    expect(storagePaths("u1", "p1", "a b.jpg")).toEqual({
      original: "originals/u1/p1/a_b.jpg",
      sidecar: "originals/u1/p1/a_b.xmp",
      thumb: "derived/u1/p1_thumb.webp",
      preview: "derived/u1/p1_preview.webp",
    });
  });
});

describe("bounded metadata, warnings, and cancellation", () => {
  afterEach(() => vi.useRealTimers());

  it("skips costly decoders for large originals while retaining XMP > camera > file precedence", async () => {
    const { deps, finalized } = makeDeps();
    deps.hash = vi.fn(async () => "a".repeat(64));
    deps.extractCapturedAt = vi.fn();
    deps.makeDerivatives = vi.fn();
    const file = makeFile("large.dng", "image/x-adobe-dng", Math.max(METADATA_MAX_BYTES, DERIVATIVES_MAX_BYTES) + 1);
    const xmp = new File(['<xmp:CreateDate>2026-08-10T12:00:00Z</xmp:CreateDate>'], "large.xmp");
    const result = await uploadOne(file, "photo-1", META, deps, undefined, { sidecar: xmp, shutter: CAPTURED });
    expect(result.status).toBe("done");
    expect(deps.extractCapturedAt).not.toHaveBeenCalled();
    expect(deps.makeDerivatives).not.toHaveBeenCalled();
    expect(finalized[0]).toMatchObject({ captured_at: "2026-08-10T12:00:00.000Z", captured_at_source: "xmp", thumb_path: null });
    expect(finalized[0].warnings).toHaveLength(2);
    expect(result.warnings).toEqual(finalized[0].warnings);
  });

  it("also skips small RAW/TIFF decoding", async () => {
    const { deps, finalized } = makeDeps();
    deps.extractCapturedAt = vi.fn();
    deps.makeDerivatives = vi.fn();
    await uploadOne(makeFile("scan.tiff", "image/tiff"), "photo-1", META, deps, undefined, { shutter: CAPTURED });
    expect(deps.makeDerivatives).not.toHaveBeenCalled();
    expect(deps.extractCapturedAt).not.toHaveBeenCalled();
    expect(finalized[0]).toMatchObject({ captured_at_source: "camera", captured_at: CAPTURED.toISOString() });
  });

  it("never reads oversized XMP text but still uploads that sidecar", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const sidecar = makeFile("a.xmp", "application/rdf+xml", SIDECAR_METADATA_MAX_BYTES + 1);
    const text = vi.spyOn(sidecar, "text");
    const slice = vi.spyOn(sidecar, "slice");
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { sidecar });
    expect(result.status).toBe("done");
    expect(text).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(uploads.some((entry) => entry.path.endsWith("a.xmp"))).toBe(true);
    expect(finalized[0].warnings).toEqual([expect.stringContaining("XMP exceeds")]);
  });

  it("keeps original and successful preview when sidecar and thumbnail calls throw", async () => {
    const { deps, uploads, finalized } = makeDeps({ throwAt: (path) => path.endsWith(".xmp") || path.includes("_thumb") });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { sidecar: makeFile("a.xmp", "application/rdf+xml") });
    expect(result.status).toBe("done");
    expect(finalized[0]).toMatchObject({ sidecar_path: null, thumb_path: null, preview_path: "derived/user-1/photo-1_preview.webp" });
    expect(uploads).toHaveLength(2);
    expect(result.warnings).toEqual(finalized[0].warnings);
    expect(result.warnings).toHaveLength(2);
  });

  it("persists missing reselected sidecar warning", async () => {
    const { deps, finalized } = makeDeps();
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { expectedSidecarName: "a.xmp" });
    expect(result.warnings).toEqual([expect.stringContaining("was not reselected")]);
    expect(finalized[0].warnings).toEqual(result.warnings);
  });

  it("cancels an outstanding hash without creating an attempt or scheduling bytes", async () => {
    const { deps, uploads } = makeDeps();
    const controller = new AbortController();
    let hashing!: () => void;
    const started = new Promise<void>((resolve) => { hashing = resolve; });
    deps.hash = vi.fn(async (_file, options) => { hashing(); expect(options?.signal).toBeDefined(); return new Promise<string>(() => {}); });
    const pending = uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { signal: controller.signal });
    await started;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect(uploads).toEqual([]);
    expect(deps.createAttempt).not.toHaveBeenCalled();
  });

  it("cancels an outstanding TUS transfer and never schedules sidecar, derivatives, or finalize", async () => {
    const { deps, uploads } = makeDeps();
    const controller = new AbortController();
    let started!: () => void;
    const transferring = new Promise<void>((resolve) => { started = resolve; });
    let transferSignal: AbortSignal | undefined;
    deps.resumableUpload = vi.fn(async (_path, _file, options) => {
      transferSignal = options.signal; started(); return new Promise<never>(() => {});
    });
    const pending = uploadOne(makeFile("a.jpg", "image/jpeg", RESUMABLE_THRESHOLD_BYTES + 1), "photo-1", META, deps, undefined, { signal: controller.signal, sidecar: makeFile("a.xmp", "application/rdf+xml") });
    await transferring;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect(transferSignal?.aborted).toBe(true);
    expect(uploads).toEqual([]);
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledWith(expect.objectContaining({ status: "retryable_failed" }));
  });

  it("renews both generations at 30 seconds and stops transfer on renewal failure", async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    deps.hash = vi.fn(async () => "a".repeat(64));
    let started!: () => void;
    const transferring = new Promise<void>((resolve) => { started = resolve; });
    let transferSignal: AbortSignal | undefined;
    deps.resumableUpload = vi.fn(async (_path, _file, options) => { transferSignal = options.signal; started(); return new Promise<never>(() => {}); });
    deps.renewLease = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lease expired"));
    const pending = uploadOne(makeFile("a.jpg", "image/jpeg", RESUMABLE_THRESHOLD_BYTES + 1), "photo-1", META, deps);
    await transferring;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
    expect(deps.renewLease).toHaveBeenCalledWith({ owner_kind: "ordinary" as const, owner_id: "photo-1", lease_generation: 1, claim_generation: 2 }, { signal: transferSignal });
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
    expect(await pending).toMatchObject({ status: "failed", error: "lease expired" });
    expect(transferSignal?.aborted).toBe(true);
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves unchanged attempt/path while same-metadata changed bytes reset both", async () => {
    const { deps, uploads } = makeDeps();
    const file = new File(["abcd"], "a.jpg", { type: "image/jpeg", lastModified: 0 });
    let identity: UploadIdentity | undefined;
    const save = (value: UploadIdentity) => { identity = value; };
    await uploadOne(file, "photo-1", META, deps, undefined, { onIdentity: save });
    const first = identity;
    await uploadOne(file, "photo-1", META, deps, undefined, { identity, onIdentity: save });
    expect(identity).toEqual(first);
    expect(uploads[0].path).toBe(uploads[3].path);
    const changed = new File(["efgh"], "a.jpg", { type: "image/jpeg", lastModified: 0 });
    await uploadOne(changed, "photo-1", META, deps, undefined, { identity, onIdentity: save });
    expect(identity?.attemptId).not.toBe(first?.attemptId);
    expect(identity?.photoId).not.toBe(first?.photoId);
    expect(uploads[6].path).not.toBe(uploads[0].path);
  });

  it("allows two independent uploads concurrently with isolated paths and leases", async () => {
    const { deps, finalized } = makeDeps();
    let active = 0;
    let maxActive = 0;
    const finish: (() => void)[] = [];
    let bothStarted!: () => void;
    const both = new Promise<void>((resolve) => { bothStarted = resolve; });
    deps.resumableUpload = vi.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { finish.push(resolve); if (finish.length === 2) bothStarted(); });
      active--; return { error: null };
    });
    const pending = Promise.all(["photo-1", "photo-2"].map((id) => uploadOne(makeFile(`${id}.mp4`, "video/mp4", RESUMABLE_THRESHOLD_BYTES + 1), id, META, deps)));
    await both;
    finish.forEach((resolve) => resolve());
    expect((await pending).map((result) => result.status)).toEqual(["done", "done"]);
    expect(maxActive).toBe(2);
    expect(new Set(finalized.map((row) => row.original_path)).size).toBe(2);
    expect(new Set(finalized.map((row) => row.owner_id)).size).toBe(2);
  });
});


describe("sidecar-only recovery", () => {
  const identity: UploadIdentity = {
    attemptId: "photo-1", photoId: "photo-1", contentSha256: "a".repeat(64),
    sourceSignature: JSON.stringify(["a.jpg", 4, 0, "image/jpeg"]),
  };
  const sidecar = () => makeFile("a.xmp", "application/rdf+xml");
  function recoverable() {
    const base = makeDeps();
    const create = base.deps.createAttempt;
    base.deps.createAttempt = vi.fn(async (input) => ({ ...await create(input), result: {
      status: "created" as const, photo_id: "photo-1", job_id: META.jobId, sidecar_retry: true,
    } }));
    return base;
  }
  it("preflights ownership then sends only XMP and attaches it without hashing or finalizing the original", async () => {
    const { deps, uploads } = recoverable();
    const storageUpload = vi.spyOn(deps.storage, "upload");
    expect(await retrySidecar(sidecar(), identity, META, deps)).toMatchObject({ status: "done", sidecarRetry: false });
    expect(uploads.map((entry) => entry.path)).toEqual(["originals/user-1/photo-1/a.xmp"]);
    expect(storageUpload).toHaveBeenCalledWith("originals/user-1/photo-1/a.xmp", expect.any(File), expect.objectContaining({ upsert: false }));
    expect(deps.hash).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.attachSidecar).toHaveBeenCalledWith({ owner_kind: "ordinary", owner_id: "photo-1", sidecar_name: "a.xmp", sidecar_bytes: 4 }, {});
  });
  it("resolves an existing-object transfer error through server metadata verification", async () => {
    const { deps } = recoverable();
    deps.storage.upload = vi.fn(async () => ({ error: { message: "Already exists" } }));
    expect((await retrySidecar(sidecar(), identity, META, deps)).status).toBe("done");
    expect(deps.attachSidecar).toHaveBeenCalledOnce();
  });
  it("retains actionable warning when neither upload nor verified attach succeeds", async () => {
    const { deps } = recoverable();
    deps.storage.upload = vi.fn(async () => { throw new Error("offline"); });
    deps.attachSidecar = vi.fn(async () => { throw new Error("Object missing"); });
    expect(await retrySidecar(sidecar(), identity, META, deps)).toMatchObject({ status: "failed", sidecarRetry: true, error: "offline", warnings: [expect.stringContaining("Sidecar upload failed")] });
  });
  it.each([false, true])("only accepts no-transfer replay when sidecar_attached is %s", async (attached) => {
    const { deps, uploads } = recoverable();
    const create = deps.createAttempt;
    deps.createAttempt = vi.fn(async (input) => ({ ...await create(input), result: {
      status: "created" as const, photo_id: "photo-1", job_id: META.jobId,
      sidecar_retry: false, sidecar_attached: attached,
    } }));
    expect((await retrySidecar(sidecar(), identity, META, deps)).status).toBe(attached ? "done" : "failed");
    expect(uploads).toEqual([]);
    expect(deps.attachSidecar).not.toHaveBeenCalled();
  });
  it("does not transfer a sidecar for someone else's canonical duplicate", async () => {
    const { deps, uploads } = recoverable();
    const create = deps.createAttempt;
    deps.createAttempt = vi.fn(async (input) => ({ ...await create(input), result: {
      status: "duplicate_active" as const, photo_id: "other-photo", job_id: META.jobId, sidecar_retry: false,
    } }));
    expect((await retrySidecar(sidecar(), identity, META, deps)).status).toBe("duplicate");
    expect(uploads).toEqual([]);
    expect(deps.attachSidecar).not.toHaveBeenCalled();
  });
});

describe("attempt lifecycle recovery", () => {
  it("resumes the same ordinary attempt after transfer interruption", async () => {
    const { deps, uploads } = makeDeps();
    let identity: UploadIdentity | undefined;
    const controller = new AbortController();
    let started!: () => void;
    const transferring = new Promise<void>((resolve) => { started = resolve; });
    const original = deps.storage.upload;
    deps.storage.upload = vi.fn(async () => { started(); return new Promise<never>(() => {}); });
    const file = makeFile("a.jpg", "image/jpeg");
    const pending = uploadOne(file, "photo-1", META, deps, undefined, { signal: controller.signal, onIdentity: (value) => { identity = value; } });
    await transferring;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect(deps.releaseLease).toHaveBeenCalledWith(expect.objectContaining({ status: "retryable_failed" }));
    const interruptedIdentity = identity;
    deps.storage.upload = original;
    expect((await uploadOne(file, "photo-1", META, deps, undefined, { identity, onIdentity: (value) => { identity = value; } })).status).toBe("done");
    expect(identity).toEqual(interruptedIdentity);
    expect(uploads[0].path).toBe("originals/user-1/photo-1/a.jpg");
  });
  it("finalizes an already completed original after losing the response and TUS URL", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const file = makeFile("a.mp4", "video/mp4", RESUMABLE_THRESHOLD_BYTES + 1);
    let identity: UploadIdentity | undefined;
    deps.resumableUpload = vi.fn(async () => ({ error: { message: "Upload response lost" } }));
    expect((await uploadOne(file, "photo-1", META, deps, undefined, { onIdentity: (value) => { identity = value; } })).status).toBe("failed");
    const originalIdentity = identity;
    deps.probeOriginal = vi.fn(async () => ({ complete: true }));
    vi.mocked(deps.resumableUpload).mockClear();
    const result = await uploadOne(file, "photo-1", META, deps, undefined, { identity, onIdentity: (value) => { identity = value; } });
    expect(result.status).toBe("done");
    expect(identity).toEqual(originalIdentity);
    expect(deps.hash).toHaveBeenCalledTimes(2);
    expect(deps.resumableUpload).not.toHaveBeenCalled();
    expect(uploads.every((entry) => entry.path.startsWith("derived/"))).toBe(true);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].original_path).toBe("originals/user-1/photo-1/a.mp4");
    expect(deps.probeOriginal).toHaveBeenCalledWith({ owner_kind: "ordinary", owner_id: "photo-1", lease_generation: 1, claim_generation: 2 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("allocates fresh paths after a prior unresolved canonical was purged, without rehashing", async () => {
    const { deps, uploads } = makeDeps();
    const create = deps.createAttempt;
    let first = true;
    deps.createAttempt = vi.fn(async (input) => {
      const attempt = await create(input);
      if (!first) return attempt;
      first = false;
      return { ...attempt, result: { status: "duplicate_trashed" as const, photo_id: "purged", job_id: META.jobId, new_attempt_required: true } };
    });
    let identity: UploadIdentity | undefined;
    expect((await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { onIdentity: (value) => { identity = value; } })).status).toBe("done");
    expect(deps.hash).toHaveBeenCalledOnce();
    expect(deps.createAttempt).toHaveBeenCalledTimes(2);
    expect(identity?.photoId).not.toBe("photo-1");
    expect(uploads[0].path).toContain(identity!.photoId);
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

describe("retry metadata survives the upload orchestrator", () => {
  const limited = () => new UploadRequestError("Rate limited; retry later", {
    code: "rate_limited", status: 429, retryable: true, retryAt: 60_000,
  });
  it.each(["plain", "tus", "claim"])("preserves long Retry-After from %s", async (transport) => {
    const { deps } = makeDeps();
    if (transport === "plain") deps.storage.upload = vi.fn(async () => ({ error: limited() }));
    if (transport === "tus") deps.resumableUpload = vi.fn(async () => ({ error: limited() }));
    if (transport === "claim") deps.claimContent = vi.fn(async () => { throw limited(); });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg", transport === "tus" ? RESUMABLE_THRESHOLD_BYTES + 1 : 4), "photo-1", META, deps);
    expect(result).toMatchObject({ status: "failed", retryable: true, retryAt: 60_000 });
  });
  it("finalizes the original while deferring a throttled sidecar retry", async () => {
    const { deps, finalized } = makeDeps();
    const transfer = deps.storage.upload;
    deps.storage.upload = vi.fn(async (path, body, options) => path.endsWith(".xmp") ? { error: limited() } : transfer(path, body, options));
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { sidecar: makeFile("a.xmp", "application/rdf+xml") });
    expect(result).toMatchObject({ status: "done", sidecarRetry: true, retryAt: 60_000 });
    expect(finalized[0].sidecar_path).toBeNull();
  });
});
