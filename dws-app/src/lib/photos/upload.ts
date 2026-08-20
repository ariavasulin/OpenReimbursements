// Upload orchestration: per-file independent, sequential (a partial batch
// keeps its successes). Each file: uuid -> exif -> derivatives -> upload the
// ORIGINAL FIRST, then derivatives, then POST the row. A mid-flight kill
// leaves only repairable states (row-less original / row without derivatives),
// which the repair loop converges. Storage and API clients are injected so
// the logic is testable without a browser or network.

import { extractCapturedAt as defaultExtractCapturedAt } from "./exif";
import {
  makeDerivatives as defaultMakeDerivatives,
  type Derivatives,
} from "./derivatives";

export type PhotoKind = "image" | "video" | "file";

export interface UploadMeta {
  jobId: string;
  /** auth.uid() of the signed-in user — prefixes every storage key. */
  uploaderId: string;
  sheetNumber?: string | null;
  tags?: string[];
}

/** Row payload POSTed to /api/photos once the files are in storage. */
export interface FinalizePayload {
  id: string;
  job_id: string;
  kind: PhotoKind;
  sheet_number: string | null;
  tags: string[];
  captured_at: string | null;
  original_path: string;
  original_bytes: number;
  mime_type: string | null;
  original_name: string;
  thumb_path: string | null;
  preview_path: string | null;
  duration_secs: number | null;
}

export interface PhotoStorage {
  upload(
    path: string,
    body: Blob | File,
    options?: { contentType?: string; upsert?: boolean }
  ): Promise<{ error: { message: string } | null }>;
}

export interface UploadDeps {
  storage: PhotoStorage;
  /** POST /api/photos; must throw on failure. */
  finalize: (payload: FinalizePayload) => Promise<void>;
  extractCapturedAt?: (file: File) => Promise<Date | null>;
  makeDerivatives?: (file: File) => Promise<Derivatives | null>;
  generateId?: () => string;
}

export interface UploadResult {
  file: File;
  photoId: string;
  status: "done" | "failed";
  /** Failed uploads are retryable: re-running uploadOne overwrites cleanly. */
  retryable: boolean;
  error?: string;
}

export type UploadProgress =
  | { type: "start"; file: File; index: number; total: number }
  | { type: "done"; file: File; index: number; total: number }
  | { type: "failed"; file: File; index: number; total: number; error: string };

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

export function kindFromMime(mime: string): PhotoKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function storagePaths(uploaderId: string, photoId: string, filename: string) {
  return {
    original: `originals/${uploaderId}/${photoId}/${sanitizeFilename(filename)}`,
    thumb: `derived/${uploaderId}/${photoId}_thumb.webp`,
    preview: `derived/${uploaderId}/${photoId}_preview.webp`,
  };
}

export async function uploadOne(
  file: File,
  meta: UploadMeta,
  deps: UploadDeps
): Promise<UploadResult> {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const extractCapturedAt = deps.extractCapturedAt ?? defaultExtractCapturedAt;
  const makeDerivatives = deps.makeDerivatives ?? defaultMakeDerivatives;

  const photoId = generateId();
  const failed = (error: string): UploadResult => ({
    file,
    photoId,
    status: "failed",
    retryable: true,
    error,
  });

  const capturedAt = await extractCapturedAt(file).catch(() => null);
  const derivatives = await makeDerivatives(file).catch(() => null);
  const paths = storagePaths(meta.uploaderId, photoId, file.name);

  // 1. Original, byte-for-byte, ALWAYS first — a kill after this point
  // leaves a repairable state, never orphan derivatives.
  const { error: originalError } = await deps.storage.upload(
    paths.original,
    file,
    { contentType: file.type || "application/octet-stream", upsert: true }
  );
  if (originalError) {
    return failed(`Upload failed: ${originalError.message}`);
  }

  // 2. Derivatives (small, best-effort). If one fails the row still lands
  // with null paths — exactly the state the repair loop fills.
  let thumbPath: string | null = null;
  let previewPath: string | null = null;
  if (derivatives) {
    const [thumbResult, previewResult] = [
      await deps.storage.upload(paths.thumb, derivatives.thumb, {
        contentType: derivatives.thumb.type || "image/webp",
        upsert: true,
      }),
      await deps.storage.upload(paths.preview, derivatives.preview, {
        contentType: derivatives.preview.type || "image/webp",
        upsert: true,
      }),
    ];
    if (!thumbResult.error && !previewResult.error) {
      thumbPath = paths.thumb;
      previewPath = paths.preview;
    }
  }

  // 3. Finalize — the row existing is what makes the photo "in".
  const payload: FinalizePayload = {
    id: photoId,
    job_id: meta.jobId,
    kind: kindFromMime(file.type || ""),
    sheet_number: meta.sheetNumber?.trim() ? meta.sheetNumber.trim() : null,
    tags: meta.tags ?? [],
    captured_at: capturedAt ? capturedAt.toISOString() : null,
    original_path: paths.original,
    original_bytes: file.size,
    mime_type: file.type || null,
    original_name: file.name,
    thumb_path: thumbPath,
    preview_path: previewPath,
    duration_secs: null,
  };

  try {
    await deps.finalize(payload);
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : "Saving the photo failed"
    );
  }

  return { file, photoId, status: "done", retryable: false };
}

export async function uploadBatch(
  files: File[],
  meta: UploadMeta,
  deps: UploadDeps,
  onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    onProgress?.({ type: "start", file, index, total: files.length });
    const result = await uploadOne(file, meta, deps);
    results.push(result);
    if (result.status === "done") {
      onProgress?.({ type: "done", file, index, total: files.length });
    } else {
      onProgress?.({
        type: "failed",
        file,
        index,
        total: files.length,
        error: result.error ?? "Upload failed",
      });
    }
  }
  return results;
}
