// Upload orchestration: per-file independent, sequential (a partial batch
// keeps its successes). Each file: uuid -> exif -> derivatives -> upload the
// ORIGINAL FIRST, then derivatives, then POST the row. A mid-flight kill
// leaves only repairable states (row-less original / row without derivatives),
// which the repair loop converges. Storage and API clients are injected so
// the logic is testable without a browser or network.
//
// Originals over 6 MB go up via resumable TUS (Supabase's
// /storage/v1/upload/resumable endpoint) so a multi-GB jobsite-LTE video
// survives drops and resumes instead of restarting. Derivatives are always
// small plain uploads.

import { Upload as TusUpload, type UploadOptions, type DetailedError } from "tus-js-client";
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

/** Byte-level progress for one file (only TUS uploads report mid-file). */
export type ByteProgress = (sentBytes: number, totalBytes: number) => void;

/**
 * Resumable upload for big originals. Same result contract as
 * PhotoStorage.upload so uploadOne treats both paths identically.
 */
export type ResumableUpload = (
  path: string,
  file: File,
  options: { contentType: string; onProgress?: ByteProgress }
) => Promise<{ error: { message: string } | null }>;

export interface UploadDeps {
  storage: PhotoStorage;
  /** POST /api/photos; must throw on failure. */
  finalize: (payload: FinalizePayload) => Promise<void>;
  /** TUS path for originals over RESUMABLE_THRESHOLD_BYTES (optional: tests
   * and environments without TUS fall back to plain uploads). */
  resumableUpload?: ResumableUpload;
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
  | {
      type: "progress";
      file: File;
      index: number;
      total: number;
      sentBytes: number;
      totalBytes: number;
    }
  | { type: "done"; file: File; index: number; total: number }
  | { type: "failed"; file: File; index: number; total: number; error: string };

/** Plain .upload() is for <=6 MB; anything bigger goes resumable (TUS). */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;
/** Supabase's TUS endpoint requires chunks of EXACTLY 6 MB. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

const PHOTOS_BUCKET = "photos";

/** Minimal structural view of tus-js-client's Upload, so tests inject fakes. */
export interface TusUploadLike {
  start(): void;
  findPreviousUploads(): Promise<unknown[]>;
  resumeFromPreviousUpload(previousUpload: unknown): void;
}

export type TusUploadCtor = new (
  file: File,
  options: UploadOptions
) => TusUploadLike;

export interface ResumableUploadConfig {
  /** e.g. process.env.NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl: string;
  /**
   * Called before EVERY chunk request — access tokens expire (~1 h) while a
   * multi-GB LTE upload is still running, so each chunk re-reads the current
   * token (supabase.auth.getSession() refreshes an expired one).
   */
  getAccessToken: () => Promise<string | null>;
  /** Test seam; defaults to the real tus-js-client Upload. */
  UploadCtor?: TusUploadCtor;
}

/**
 * Build the ResumableUpload dep: browser -> Supabase Storage directly over
 * TUS (originals can be multi-GB; they never pass through a Next.js route).
 */
export function createResumableUpload(
  config: ResumableUploadConfig
): ResumableUpload {
  const UploadCtor: TusUploadCtor =
    config.UploadCtor ?? (TusUpload as unknown as TusUploadCtor);

  return (path, file, options) =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (error: { message: string } | null) => {
        if (!settled) {
          settled = true;
          resolve({ error });
        }
      };

      const upload = new UploadCtor(file, {
        endpoint: `${config.supabaseUrl}/storage/v1/upload/resumable`,
        chunkSize: TUS_CHUNK_BYTES,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        headers: { "x-upsert": "true" },
        metadata: {
          bucketName: PHOTOS_BUCKET,
          objectName: path,
          contentType: options.contentType,
          cacheControl: "3600",
        },
        // Fresh token on every request — this is what lets a chunk sent an
        // hour into an upload (or a resume after a kill) still authorize.
        onBeforeRequest: async (req) => {
          const token = await config.getAccessToken();
          if (!token) throw new Error("Signed out — sign in and retry");
          req.setHeader("Authorization", `Bearer ${token}`);
        },
        onShouldRetry: (error) => {
          const status =
            (error as DetailedError).originalResponse?.getStatus() ?? 0;
          // Connection drops (0) and server errors are retryable; 401 too —
          // onBeforeRequest refreshes the token on the next attempt. Other
          // 4xx (403 wrong prefix, 413 too big) won't heal by retrying.
          return (
            status === 0 || status >= 500 || status === 401 || status === 409 || status === 423
          );
        },
        onProgress: (sent, total) => options.onProgress?.(sent, total),
        onError: (error) => settle({ message: error.message }),
        onSuccess: () => settle(null),
      });

      // Resume a previous attempt of this same file when one exists (TUS
      // fingerprints file+endpoint; upload URLs stay valid for 24 h).
      upload
        .findPreviousUploads()
        .then((previous) => {
          if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
          upload.start();
        })
        .catch(() => upload.start());
    });
}

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
  deps: UploadDeps,
  onBytes?: ByteProgress
): Promise<UploadResult> {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const photoId = generateId();
  const failed = (error: string): UploadResult => ({
    file,
    photoId,
    status: "failed",
    retryable: true,
    error,
  });

  try {
    return await uploadOneSteps(file, meta, deps, photoId, failed, onBytes);
  } catch (error) {
    // A storage client that THROWS (network drop, killed connection) must
    // not take the rest of the batch down — per-file independence.
    return failed(error instanceof Error ? error.message : "Upload failed");
  }
}

async function uploadOneSteps(
  file: File,
  meta: UploadMeta,
  deps: UploadDeps,
  photoId: string,
  failed: (error: string) => UploadResult,
  onBytes?: ByteProgress
): Promise<UploadResult> {
  const extractCapturedAt = deps.extractCapturedAt ?? defaultExtractCapturedAt;
  const makeDerivatives = deps.makeDerivatives ?? defaultMakeDerivatives;

  const capturedAt = await extractCapturedAt(file).catch(() => null);
  const derivatives = await makeDerivatives(file).catch(() => null);
  const paths = storagePaths(meta.uploaderId, photoId, file.name);

  // 1. Original, byte-for-byte, ALWAYS first — a kill after this point
  // leaves a repairable state, never orphan derivatives. Over the plain
  // upload ceiling the original goes resumable (TUS) so it survives drops.
  const contentType = file.type || "application/octet-stream";
  const useResumable =
    Boolean(deps.resumableUpload) && file.size > RESUMABLE_THRESHOLD_BYTES;
  const { error: originalError } = useResumable
    ? await deps.resumableUpload!(paths.original, file, {
        contentType,
        onProgress: onBytes,
      })
    : await deps.storage.upload(paths.original, file, {
        contentType,
        upsert: true,
      });
  if (originalError) {
    return failed(`Upload failed: ${originalError.message}`);
  }
  onBytes?.(file.size, file.size);

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
    duration_secs: derivatives?.durationSecs ?? null,
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
    const result = await uploadOne(file, meta, deps, (sentBytes, totalBytes) =>
      onProgress?.({
        type: "progress",
        file,
        index,
        total: files.length,
        sentBytes,
        totalBytes,
      })
    );
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
