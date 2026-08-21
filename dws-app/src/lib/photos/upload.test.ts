import { describe, expect, it, vi } from "vitest";
import type {
  DetailedError,
  HttpRequest,
  UploadOptions,
} from "tus-js-client";
import {
  createResumableUpload,
  kindFromMime,
  RESUMABLE_THRESHOLD_BYTES,
  sanitizeFilename,
  storagePaths,
  TUS_CHUNK_BYTES,
  uploadOne,
  type FinalizePayload,
  type TusUploadCtor,
  type UploadDeps,
  type UploadMeta,
} from "./upload";

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
  let idCounter = 0;

  const deps: UploadDeps = {
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
    }),
    extractCapturedAt: async () => CAPTURED,
    makeDerivatives: async () =>
      overrides?.noDerivatives
        ? null
        : {
            thumb: new Blob(["t"], { type: "image/webp" }),
            preview: new Blob(["p"], { type: "image/webp" }),
          },
    generateId: () => `photo-${++idCounter}`,
  };

  return { deps, uploads, finalized };
}

function makeFile(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("uploadOne", () => {
  it("uploads the original FIRST, then derivatives, then POSTs the row", async () => {
    const { deps, uploads, finalized } = makeDeps();
    const file = makeFile("IMG_0001.jpg", "image/jpeg", 10);

    const result = await uploadOne(file, META, deps);

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
      original_path: "originals/user-1/photo-1/IMG_0001.jpg",
      original_bytes: 10,
      mime_type: "image/jpeg",
      original_name: "IMG_0001.jpg",
      thumb_path: "derived/user-1/photo-1_thumb.webp",
      preview_path: "derived/user-1/photo-1_preview.webp",
    });
  });

  it("marks the file failed when the row POST fails", async () => {
    const { deps, finalized } = makeDeps({ failFinalize: true });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), META, deps);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("db says no");
    expect(finalized).toHaveLength(0);
  });

  it("fails without finalizing when the ORIGINAL upload fails", async () => {
    const { deps, uploads } = makeDeps({
      failUploadPaths: (path) => path.startsWith("originals/"),
    });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), META, deps);

    expect(result.status).toBe("failed");
    expect(uploads).toHaveLength(0); // derivatives never went up either
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it("still lands the row (null derivative paths) when a derivative upload fails", async () => {
    const { deps, finalized } = makeDeps({
      failUploadPaths: (path) => path.includes("_thumb"),
    });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), META, deps);

    expect(result.status).toBe("done");
    expect(finalized[0].thumb_path).toBeNull();
    expect(finalized[0].preview_path).toBeNull();
  });

  it("handles undecodable files: no derivatives, row lands with nulls", async () => {
    const { deps, uploads, finalized } = makeDeps({ noDerivatives: true });
    const file = makeFile("shot.CR3", "", 6);

    const result = await uploadOne(file, META, deps);

    expect(result.status).toBe("done");
    expect(uploads).toHaveLength(1); // only the original
    expect(finalized[0]).toMatchObject({
      kind: "file",
      mime_type: null,
      thumb_path: null,
      preview_path: null,
    });
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

    const result = await uploadOne(file, META, deps);

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

    const result = await uploadOne(file, META, deps);

    expect(result.status).toBe("done");
    expect(resumableCalls).toHaveLength(0);
    expect(uploads[0].path).toBe("originals/user-1/photo-1/small.jpg");
  });

  it("reports byte progress from TUS and a final size/size tick", async () => {
    const { deps } = withResumable();
    const file = makeFile("big.mp4", "video/mp4", bigSize);
    const ticks: [number, number][] = [];

    await uploadOne(file, META, deps, (sent, total) => ticks.push([sent, total]));

    expect(ticks.at(-1)).toEqual([bigSize, bigSize]);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i][0]).toBeGreaterThanOrEqual(ticks[i - 1][0]);
    }
  });

  it("fails (no finalize) when the TUS upload errors out", async () => {
    const { deps, finalized } = withResumable({ failResumable: true });
    const file = makeFile("big.mp4", "video/mp4", bigSize);

    const result = await uploadOne(file, META, deps);

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
            originalResponse: { getStatus: () => status },
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
  // original, a row never exists without its original, and a plain retry
  // (new photo id) converges to a complete photo. Leftover row-less
  // objects are exactly what the repair cron's orphan sweep deletes.
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

  it.each<KillPoint>(["original", "thumb", "preview", "finalize"])(
    "a kill at %s leaves a repairable state, and a retry converges",
    async (killPoint) => {
      const kill = { at: killPoint as KillPoint | null };
      const { deps, uploads, finalized: rows } = makeDeps({
        throwAt: (path) => kill.at === stepFor(path),
      });
      const file = makeFile("IMG_0042.jpg", "image/jpeg", 10);

      const killed = await uploadOne(file, META, deps);

      expect(killed.status).toBe("failed");
      expect(rows).toHaveLength(0); // no kill point leaves a phantom row
      expectRepairableState(uploads, rows);

      // The user taps Retry (network is back): the file converges.
      kill.at = null;
      const retried = await uploadOne(file, META, deps);

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

describe("kindFromMime / storagePaths", () => {
  it("classifies mime types", () => {
    expect(kindFromMime("image/jpeg")).toBe("image");
    expect(kindFromMime("video/quicktime")).toBe("video");
    expect(kindFromMime("application/octet-stream")).toBe("file");
    expect(kindFromMime("")).toBe("file");
  });

  it("builds own-prefix keys", () => {
    expect(storagePaths("u1", "p1", "a b.jpg")).toEqual({
      original: "originals/u1/p1/a_b.jpg",
      thumb: "derived/u1/p1_thumb.webp",
      preview: "derived/u1/p1_preview.webp",
    });
  });
});
