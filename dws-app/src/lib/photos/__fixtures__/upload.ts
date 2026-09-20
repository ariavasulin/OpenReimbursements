import { vi } from "vitest";
import { createHash } from "node:crypto";
import { extensionOf } from "../classify";
import type { UploadDeps, UploadMeta } from "../upload";
import type { FinalizeUploadInput } from "../upload-contract";

/** Storage keys must be safe ASCII; the true filename lives in original_name. */
export function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const clean = (part: string) =>
    part
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  const cleanBase = clean(base) || "file";
  const cleanExt = clean(ext);
  return cleanExt ? `${cleanBase}.${cleanExt}` : cleanBase;
}

export function storagePaths(uploaderId: string, photoId: string, filename: string) {
  const sanitized = sanitizeFilename(filename);
  const ext = extensionOf(sanitized);
  const base = ext ? sanitized.slice(0, -(ext.length + 1)) : sanitized;
  return {
    original: `originals/${uploaderId}/${photoId}/${sanitized}`,
    sidecar: `originals/${uploaderId}/${photoId}/${base}.xmp`,
    thumb: `derived/${uploaderId}/${photoId}_thumb.webp`,
    preview: `derived/${uploaderId}/${photoId}_preview.webp`,
  };
}

export const sha256 = async (file: File) => createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");

export const META: UploadMeta = {
  jobId: "0b7f0000-0000-4000-8000-000000000001",
  uploaderId: "user-1",
  sheetNumber: "12",
  tags: ["professional"],
};

export const CAPTURED = new Date("2026-08-14T14:41:00.000Z");

export interface Recorded {
  path: string;
  contentType?: string;
  bytes: number;
}

export function makeDeps(overrides?: {
  failUploadPaths?: (path: string) => boolean;
  /** Simulate the tab dying mid-step: throws at matching storage paths, or at
   * "finalize" for the row POST. */
  throwAt?: (path: string) => boolean;
  failFinalize?: boolean;
  noDerivatives?: boolean;
}) {
  const uploads: Recorded[] = [];
  const finalized: FinalizeUploadInput[] = [];

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
    finalize: vi.fn(async (payload: FinalizeUploadInput) => {
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

export function makeFile(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 0 });
}
