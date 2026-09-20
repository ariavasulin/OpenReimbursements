import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UploadRequestError } from "./upload-http";
import {
  LEASE_RENEW_MS,
  type UploadIdentity,
  type UploadDeps,
  uploadOne, retrySidecar,
} from "./upload";
import { METADATA_MAX_BYTES, DERIVATIVES_MAX_BYTES } from "./decode-limits";
import { SIDECAR_METADATA_MAX_BYTES } from "./sidecar";
import { RESUMABLE_THRESHOLD_BYTES, TUS_CHUNK_BYTES } from "./upload-tus";
import type { CanonicalUploadOutcome, FinalizeUploadInput } from "./upload-contract";
import { makeDeps, makeFile, META, CAPTURED, sanitizeFilename, storagePaths, sha256, type Recorded } from "./__fixtures__/upload";

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
    expect(await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps)).toMatchObject({
      status: "waiting_claim", retryable: true, retryAt: Date.parse("2026-09-07T00:02:00Z"),
    });
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
    rows: FinalizeUploadInput[]
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

  it("stops waiting for a pending XMP read when cancelled and schedules no transfer", async () => {
    const { deps, uploads } = makeDeps();
    const controller = new AbortController();
    const sidecar = makeFile("a.xmp", "application/rdf+xml");
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.spyOn(sidecar, "text").mockImplementation(() => { reading(); return new Promise<string>(() => {}); });
    const pending = uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps, undefined, { sidecar, signal: controller.signal });
    await started;
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    expect(uploads).toEqual([]);
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.releaseLease).toHaveBeenCalledWith(expect.objectContaining({ status: "retryable_failed" }));
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

describe("retry metadata survives the upload orchestrator", () => {
  it("preserves the fresh-attempt remedy without transferring to an occupied path", async () => {
    const { deps, uploads } = makeDeps();
    deps.probeOriginal = vi.fn(async () => { throw new UploadRequestError("Start a fresh attempt", {
      code: "conflict", status: 409, retryable: false, newAttemptRequired: true,
    }); });
    expect(await uploadOne(makeFile("a.jpg", "image/jpeg"), "photo-1", META, deps)).toMatchObject({
      status: "failed", retryable: false, newAttemptRequired: true, errorCode: "conflict",
    });
    expect(uploads).toEqual([]);
    expect(deps.finalize).not.toHaveBeenCalled();
  });
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
