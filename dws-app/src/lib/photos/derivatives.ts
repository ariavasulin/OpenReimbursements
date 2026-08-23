// Client-side derivative generation: the uploader's browser already holds
// decoded pixels, so it makes the grid thumbnail and lightbox preview on a
// canvas. Videos get a poster frame (seek -> canvas) plus their duration —
// Supabase has no server-side transcoding, so upload time is the only place
// a poster can come from. Returns null when the file can't be decoded (HEIC
// on Chrome, RAW, companion files) — those rows converge later via the
// repair loop.

export const THUMB_MAX_DIM = 640;
export const PREVIEW_MAX_DIM = 2048;
/** Poster frame target: ~1s in (frame 0 is often black), capped mid-clip. */
export const POSTER_SEEK_SECS = 1;
const WEBP_QUALITY = 0.8;
const VIDEO_DECODE_TIMEOUT_MS = 15_000;

export interface Derivatives {
  /** ~640px WebP for grids (sharp in a ~190px tile on a 2x display). */
  thumb: Blob;
  /** ~2048px WebP for the lightbox (a video's poster frame). */
  preview: Blob;
  /** Video duration in seconds; null for images. */
  durationSecs: number | null;
}

export async function makeDerivatives(
  file: File | Blob
): Promise<Derivatives | null> {
  if (file.type.startsWith("video/")) return makeVideoDerivatives(file);
  return makeImageDerivatives(file);
}

async function makeImageDerivatives(
  file: File | Blob
): Promise<Derivatives | null> {
  if (typeof createImageBitmap === "undefined") return null;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF orientation, so rotated phone photos
    // come out upright (the bitmap's width/height are post-rotation).
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null; // undecodable in this browser
  }

  try {
    const [thumb, preview] = await Promise.all([
      scaleToWebp(bitmap, THUMB_MAX_DIM),
      scaleToWebp(bitmap, PREVIEW_MAX_DIM),
    ]);
    if (!thumb || !preview) return null;
    return { thumb, preview, durationSecs: null };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** Wait for one of the events, rejecting on "error" or after a timeout. */
function nextEvent(
  target: {
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  },
  type: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("video decode error"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(type, onDone);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(type, onDone);
    target.addEventListener("error", onError);
  });
}

/**
 * Poster frame + duration for a video the browser can play: load metadata,
 * seek ~1s in, grab the frame, and scale it into the usual thumb/preview.
 * Null when this browser can't decode the codec — the row still lands and
 * shows as a labeled tile until the repair loop (or never; downloads work).
 */
async function makeVideoDerivatives(
  file: File | Blob
): Promise<Derivatives | null> {
  if (
    typeof document === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    return null;
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  let bitmap: ImageBitmap | null = null;
  try {
    const metadataLoaded = nextEvent(
      video,
      "loadedmetadata",
      VIDEO_DECODE_TIMEOUT_MS
    );
    video.src = url;
    await metadataLoaded;

    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : null;

    const seeked = nextEvent(video, "seeked", VIDEO_DECODE_TIMEOUT_MS);
    video.currentTime = duration
      ? Math.min(POSTER_SEEK_SECS, duration / 2)
      : POSTER_SEEK_SECS;
    await seeked;

    bitmap = await createImageBitmap(video);
    const [thumb, preview] = await Promise.all([
      scaleToWebp(bitmap, THUMB_MAX_DIM),
      scaleToWebp(bitmap, PREVIEW_MAX_DIM),
    ]);
    if (!thumb || !preview) return null;
    return { thumb, preview, durationSecs: duration };
  } catch {
    return null;
  } finally {
    bitmap?.close();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

/** Scale the bitmap so its longest side is at most maxDim (never upscale). */
async function scaleToWebp(
  bitmap: ImageBitmap,
  maxDim: number
): Promise<Blob | null> {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      // Note: a browser that can't encode WebP may hand back another type
      // (e.g. PNG); callers use blob.type as the upload content type.
      return canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    }
  }

  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", WEBP_QUALITY)
  );
}
