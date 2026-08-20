import { describe, expect, it, vi } from "vitest";
import {
  kindFromMime,
  sanitizeFilename,
  storagePaths,
  uploadBatch,
  uploadOne,
  type FinalizePayload,
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
  failFinalize?: boolean;
  noDerivatives?: boolean;
}) {
  const uploads: Recorded[] = [];
  const finalized: FinalizePayload[] = [];
  let idCounter = 0;

  const deps: UploadDeps = {
    storage: {
      async upload(path, body, options) {
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

  it("marks the file failed and retryable when the row POST fails", async () => {
    const { deps, finalized } = makeDeps({ failFinalize: true });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), META, deps);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("db says no");
    expect(finalized).toHaveLength(0);
  });

  it("fails without finalizing when the ORIGINAL upload fails", async () => {
    const { deps, uploads } = makeDeps({
      failUploadPaths: (path) => path.startsWith("originals/"),
    });
    const result = await uploadOne(makeFile("a.jpg", "image/jpeg"), META, deps);

    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
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

describe("uploadBatch", () => {
  it("is per-file independent: one failure doesn't stop the rest", async () => {
    const { deps, finalized } = makeDeps();
    let call = 0;
    deps.finalize = vi.fn(async (payload: FinalizePayload) => {
      call += 1;
      if (call === 2) throw new Error("flaky network");
      finalized.push(payload);
    });

    const events: string[] = [];
    const results = await uploadBatch(
      [
        makeFile("1.jpg", "image/jpeg"),
        makeFile("2.jpg", "image/jpeg"),
        makeFile("3.jpg", "image/jpeg"),
      ],
      META,
      deps,
      (progress) => events.push(`${progress.type}:${progress.index}`)
    );

    expect(results.map((r) => r.status)).toEqual(["done", "failed", "done"]);
    expect(results[1].retryable).toBe(true);
    expect(finalized).toHaveLength(2);
    expect(events).toEqual([
      "start:0",
      "done:0",
      "start:1",
      "failed:1",
      "start:2",
      "done:2",
    ]);
  });
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
