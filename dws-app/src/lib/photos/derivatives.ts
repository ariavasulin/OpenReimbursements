// Client-side derivative generation: the uploader's browser already holds
// decoded pixels, so it makes the grid thumbnail and lightbox preview on a
// canvas. Returns null when the file can't be decoded (HEIC on Chrome, RAW,
// videos, companion files) — those rows converge later via the repair loop.

export const THUMB_MAX_DIM = 400;
export const PREVIEW_MAX_DIM = 2048;
const WEBP_QUALITY = 0.8;

export interface Derivatives {
  /** ~400px WebP for grids. */
  thumb: Blob;
  /** ~2048px WebP for the lightbox. */
  preview: Blob;
}

export async function makeDerivatives(
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
    const thumb = await scaleToWebp(bitmap, THUMB_MAX_DIM);
    const preview = await scaleToWebp(bitmap, PREVIEW_MAX_DIM);
    if (!thumb || !preview) return null;
    return { thumb, preview };
  } catch {
    return null;
  } finally {
    bitmap.close?.();
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
    if (ctx && typeof canvas.convertToBlob === "function") {
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
