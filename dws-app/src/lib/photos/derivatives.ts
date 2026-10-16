// Client-side derivative generation: the uploader's browser already holds
// decoded pixels, so it makes the grid thumbnail and lightbox preview on a
// canvas. Videos get a poster frame (seek -> canvas) plus their duration —
// Supabase has no server-side transcoding, so upload time is the only place
// a poster can come from. Returns null when the file can't be decoded (HEIC
// on Chrome, RAW, companion files) — those rows converge later via the
// repair loop.
//
// Format: WebP where the browser can encode it, JPEG where it cannot. Every
// iOS browser is WebKit, and WebKit cannot encode WebP from a canvas (it
// quietly hands back a PNG, ~15x the bytes of a WebP thumb). The stored key
// keeps its `.webp` name either way: SQL fixes the derived paths, and
// browsers pick the decoder from the Content-Type (the blob's type), not the
// file name.

export const THUMB_MAX_DIM = 640;
export const PREVIEW_MAX_DIM = 2048;
/** Poster frame target: ~1s in (frame 0 is often black), capped mid-clip. */
export const POSTER_SEEK_SECS = 1;
/** One quality for both formats: ~40-70 KB for a JPEG thumb, ~300 KB for a
 * JPEG preview, close to the WebP sizes. */
export const ENCODE_QUALITY = 0.8;
const VIDEO_DECODE_TIMEOUT_MS = 15_000;

export interface Derivatives {
  /** ~640px WebP or JPEG for grids (sharp in a ~190px tile on a 2x display). */
  thumb: Blob;
  /** ~2048px WebP or JPEG for the lightbox (a video's poster frame). */
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
      scaleAndEncode(bitmap, THUMB_MAX_DIM),
      scaleAndEncode(bitmap, PREVIEW_MAX_DIM),
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
      scaleAndEncode(bitmap, THUMB_MAX_DIM),
      scaleAndEncode(bitmap, PREVIEW_MAX_DIM),
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

/** A 2D canvas of either kind, reduced to what encoding needs. */
interface Surface {
  /** The canvas class; which formats encode is a property of the class. */
  kind: object;
  /** A same-kind canvas at another size (the 1x1 WebP probe). */
  sibling(width: number, height: number): Surface | null;
  draw(bitmap: ImageBitmap): void;
  encode(type: string): Promise<Blob | null>;
}

function offscreenSurface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return {
    kind: OffscreenCanvas,
    sibling: offscreenSurface,
    draw: (bitmap) => ctx.drawImage(bitmap, 0, 0, width, height),
    encode: (type) => canvas.convertToBlob({ type, quality: ENCODE_QUALITY }),
  };
}

function elementSurface(width: number, height: number): Surface | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  return {
    kind: canvas.constructor,
    sibling: elementSurface,
    draw: (bitmap) => ctx.drawImage(bitmap, 0, 0, width, height),
    encode: (type) =>
      new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, ENCODE_QUALITY)
      ),
  };
}

/** Whether this canvas kind really encodes WebP, asked once with a 1x1
 * canvas and remembered. Asking up front, rather than encoding a full-size
 * WebP and checking afterwards, spares an iPhone a wasted multi-megabyte PNG
 * encode on every photo. */
const webpSupport = new WeakMap<object, Promise<boolean>>();

function canEncodeWebp(surface: Surface): Promise<boolean> {
  let known = webpSupport.get(surface.kind);
  if (!known) {
    const probe = surface.sibling(1, 1);
    known = probe
      ? probe.encode("image/webp").then(
          (blob) => blob?.type === "image/webp",
          () => false
        )
      : Promise.resolve(false);
    webpSupport.set(surface.kind, known);
  }
  return known;
}

/** Scale the bitmap so its longest side is at most maxDim (never upscale),
 * then encode it as WebP, or as JPEG where WebP is not available. The blob's
 * type is checked, never assumed: a browser that cannot encode the requested
 * type returns a PNG without saying so. Null when neither format came out:
 * the photo then gets its previews from the server renderer instead of a
 * multi-megabyte PNG being stored. */
async function scaleAndEncode(
  bitmap: ImageBitmap,
  maxDim: number
): Promise<Blob | null> {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const surface =
    offscreenSurface(width, height) ?? elementSurface(width, height);
  if (!surface) return null;
  surface.draw(bitmap);

  if (await canEncodeWebp(surface)) {
    const webp = await surface.encode("image/webp");
    if (webp?.type === "image/webp") return webp;
  }
  const jpeg = await surface.encode("image/jpeg");
  return jpeg?.type === "image/jpeg" ? jpeg : null;
}
