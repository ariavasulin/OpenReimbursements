// Upload orchestration: per file, original FIRST, then derivatives, then POST
// the row. Storage and API clients are injected so the logic is testable
// without a browser or network.

import { Upload as TusUpload, type UploadOptions, type DetailedError } from "tus-js-client";
import {
  extractCapturedAt as defaultExtractCapturedAt,
  type CapturedAt,
} from "./exif";
import { classifyFile, rewrap } from "./classify";
import { readSidecarMeta } from "./sidecar";
import {
  makeDerivatives as defaultMakeDerivatives,
  type Derivatives,
} from "./derivatives";
import type { CapturedAtSource, PhotoKind } from "./types";

export interface UploadMeta {
  jobId: string;
  /** auth.uid() of the signed-in user — prefixes every storage key. */
  uploaderId: string;
  sheetNumber?: string | null;
  tags?: string[];
}

/** What the sheet hands the manager: meta plus per-file shutter times. */
export interface BatchMeta extends Omit<UploadMeta, "uploaderId"> {
  shutterAt?: Map<File, Date>;
}

/** Row payload POSTed to /api/photos once the files are in storage. */
export interface FinalizePayload {
  id: string;
  job_id: string;
  kind: PhotoKind;
  sheet_number: string | null;
  tags: string[];
  captured_at: string | null;
  /** Where captured_at came from; 'upload' when captured_at is null (the
   * server stamps now()). */
  captured_at_source: CapturedAtSource;
  original_path: string;
  original_bytes: number;
  mime_type: string | null;
  original_name: string;
  thumb_path: string | null;
  preview_path: string | null;
  duration_secs: number | null;
  /** Attached .xmp beside the original; both null when there is none (or its
   * upload failed — the row still lands). */
  sidecar_path: string | null;
  sidecar_name: string | null;
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
  /** POST /api/photos; must throw on failure. Resolves alreadyExists on an
   * idempotent replay (same photoId retried after the row already landed). */
  finalize: (payload: FinalizePayload) => Promise<{ alreadyExists?: boolean }>;
  /** TUS path for originals over RESUMABLE_THRESHOLD_BYTES (optional: tests
   * and environments without TUS fall back to plain uploads). */
  resumableUpload?: ResumableUpload;
  extractCapturedAt?: (
    file: File,
    opts?: { shutter?: Date; sidecarDate?: Date | null }
  ) => Promise<CapturedAt>;
  makeDerivatives?: (file: File) => Promise<Derivatives | null>;
}

export interface UploadResult {
  status: "done" | "failed" | "duplicate";
  error?: string;
}

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
      const settle = (error: { message: string } | null) => resolve({ error });

      const upload = new UploadCtor(file, {
        endpoint: `${config.supabaseUrl}/storage/v1/upload/resumable`,
        chunkSize: TUS_CHUNK_BYTES,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        // tus-js-client's default fingerprint omits the objectName. Including
        // the path scopes resumes to THIS object: a retry with the same
        // photoId (same path) resumes its own bytes, and an upload to a
        // different path can never adopt a dead attempt's URL.
        fingerprint: async () =>
          [
            "tus-sb",
            PHOTOS_BUCKET,
            path,
            file.name,
            file.type,
            file.size,
            file.lastModified,
          ].join("-"),
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
          // Connection drops (0), 5xx, 409/423 (storage lock contention), and
          // 401 (onBeforeRequest refreshes the token on the next attempt) are
          // retryable. Other 4xx (403 wrong prefix, 413 too big) won't heal.
          return (
            status === 0 || status >= 500 || status === 401 || status === 409 || status === 423
          );
        },
        onProgress: (sent, total) => options.onProgress?.(sent, total),
        onError: (error) => settle({ message: error.message }),
        onSuccess: () => settle(null),
      });

      // Upload URLs stay valid for 24 h.
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
  const sanitized = sanitizeFilename(filename);
  return {
    original: `originals/${uploaderId}/${photoId}/${sanitized}`,
    // The paired .xmp lives beside its original, named after it.
    sidecar: `originals/${uploaderId}/${photoId}/${sanitized.replace(/\.[^.]*$/, "")}.xmp`,
    thumb: `derived/${uploaderId}/${photoId}_thumb.webp`,
    preview: `derived/${uploaderId}/${photoId}_preview.webp`,
  };
}

export async function uploadOne(
  rawFile: File,
  /** Owned by the caller (the upload manager) and STABLE across retries — a
   * retry resumes the same TUS fingerprint and replays the same row id
   * instead of orphaning the first attempt. */
  photoId: string,
  meta: UploadMeta,
  deps: UploadDeps,
  onBytes?: ByteProgress,
  /** Per-file extras: the in-app camera shutter time (date source 'camera')
   * and the paired .xmp sidecar (uploaded beside the original). */
  opts: { shutter?: Date; sidecar?: File } = {}
): Promise<UploadResult> {
  const failed = (error: string): UploadResult => ({ status: "failed", error });

  try {
    const extractCapturedAt =
      deps.extractCapturedAt ?? defaultExtractCapturedAt;
    const makeDerivatives = deps.makeDerivatives ?? defaultMakeDerivatives;

    // Extension-first classification; the original is re-wrapped (same
    // bytes) so the stored object's Content-Type is the canonical mime, not
    // the browser's guess.
    const classified = classifyFile(rawFile);
    const file = rewrap(rawFile, classified.mime);
    const [capturedAt, derivatives] = await Promise.all([
      (async (): Promise<CapturedAt> => {
        // The sidecar's date only matters when the image itself has no EXIF
        // (extractCapturedAt owns that priority).
        const sidecarDate = opts.sidecar
          ? (await readSidecarMeta(opts.sidecar)).capturedAt
          : null;
        return extractCapturedAt(file, { shutter: opts.shutter, sidecarDate });
      })().catch((): CapturedAt => ({ date: null, source: "upload" })),
      makeDerivatives(file).catch(() => null),
    ]);
    const paths = storagePaths(meta.uploaderId, photoId, file.name);

    // 1. Original, byte-for-byte, ALWAYS first — a kill after this point
    // leaves a repairable state, never orphan derivatives.
    const contentType = classified.mime;
    const resumable =
      file.size > RESUMABLE_THRESHOLD_BYTES ? deps.resumableUpload : undefined;
    const { error: originalError } = resumable
      ? await resumable(paths.original, file, {
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

    // 2. Sidecar (tiny, best-effort) right after its original. On failure the
    // row still lands with null sidecar columns — but unlike derivatives the
    // repair sweep can't recreate an .xmp, so leave a trace in the console.
    let sidecarPath: string | null = null;
    if (opts.sidecar) {
      const { error: sidecarError } = await deps.storage.upload(
        paths.sidecar,
        opts.sidecar,
        { contentType: "application/rdf+xml", upsert: true }
      );
      if (sidecarError) {
        console.warn(
          `photos.upload sidecar failed photoId=${photoId} err=${sidecarError.message}`
        );
      } else {
        sidecarPath = paths.sidecar;
      }
    }

    // 3. Derivatives (small, best-effort). If one fails the row still lands
    // with null paths — exactly the state the repair loop fills.
    let thumbPath: string | null = null;
    let previewPath: string | null = null;
    if (derivatives) {
      const [thumbResult, previewResult] = await Promise.all([
        deps.storage.upload(paths.thumb, derivatives.thumb, {
          contentType: derivatives.thumb.type || "image/webp",
          upsert: true,
        }),
        deps.storage.upload(paths.preview, derivatives.preview, {
          contentType: derivatives.preview.type || "image/webp",
          upsert: true,
        }),
      ]);
      if (!thumbResult.error && !previewResult.error) {
        thumbPath = paths.thumb;
        previewPath = paths.preview;
      }
    }

    // 4. Finalize — the row existing is what makes the photo "in".
    const payload: FinalizePayload = {
      id: photoId,
      job_id: meta.jobId,
      // 'sidecar' never lands as its own kind — until pairing (Phase 3) a
      // lone .xmp stays a plain file tile.
      kind: classified.kind === "sidecar" ? "file" : classified.kind,
      sheet_number: meta.sheetNumber?.trim() || null,
      tags: meta.tags ?? [],
      captured_at: capturedAt.date ? capturedAt.date.toISOString() : null,
      captured_at_source: capturedAt.date ? capturedAt.source : "upload",
      original_path: paths.original,
      original_bytes: file.size,
      mime_type: classified.mime,
      original_name: file.name,
      thumb_path: thumbPath,
      preview_path: previewPath,
      duration_secs: derivatives?.durationSecs ?? null,
      // Both or neither: a name without a stored object is useless.
      sidecar_path: sidecarPath,
      sidecar_name: sidecarPath ? (opts.sidecar?.name ?? null) : null,
    };

    // alreadyExists (an idempotent replay of a photoId that finalized before
    // the client heard about it) is still "done" — the photo is in.
    await deps.finalize(payload);

    return { status: "done" };
  } catch (error) {
    // A storage client that THROWS (network drop, killed connection) must
    // not take the rest of the batch down — per-file independence.
    return failed(error instanceof Error ? error.message : "Upload failed");
  }
}
