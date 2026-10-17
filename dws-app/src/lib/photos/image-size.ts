// Pixel size from an image file's header, without decoding it. The browser
// decodes a photo at full size to make its previews (about 4 bytes a pixel:
// 192 MB for a 48 MP shot), and a file-size limit cannot see that: a 48-200 MP
// phone JPEG or HEIC still fits under 24 MB. Above PREVIEW_MAX_PIXELS the
// upload leaves the previews to the server instead.

/** About 160 MB of decoded pixels: the most an upload decodes in the browser. */
export const PREVIEW_MAX_PIXELS = 40_000_000;

/** The header and the boxes or segments before the pixels fit well inside this. */
const HEADER_BYTES = 512 * 1024;

export interface ImageSize { width: number; height: number }

/** Width and height from the header, or null when the format is unknown or the header is cut short. */
export async function readImageSize(file: Blob): Promise<ImageSize | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return null;
  }
  return parseImageSize(bytes);
}

/** True only when the header names a size over the limit; an unreadable header decodes as before. */
export async function exceedsPreviewPixels(file: Blob, limit = PREVIEW_MAX_PIXELS): Promise<boolean> {
  const size = await readImageSize(file);
  return size !== null && size.width * size.height > limit;
}

export function parseImageSize(bytes: Uint8Array): ImageSize | null {
  const size = jpegSize(bytes) ?? pngSize(bytes) ?? webpSize(bytes) ?? isoBmffSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * Walk the segments to the first start-of-frame. Each segment is skipped by
 * its length, so the small preview JPEG inside the EXIF block is never read
 * as the photo's size.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    // Markers with no length: TEM, RSTn, SOI/EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16(b, i + 5), width: u16(b, i + 7) };
    }
    i += 2 + u16(b, i + 2);
  }
  return null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || u32(b, 0) !== 0x89504e47 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32(b, 16), height: u32(b, 20) };
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * HEIC, HEIF and AVIF: the sizes live in `ispe` properties under
 * meta > iprp > ipco. A HEIC holds one for the whole picture and smaller ones
 * for its tiles and thumbnail, so the largest is the photo.
 */
function isoBmffSize(b: Uint8Array): ImageSize | null {
  if (b.length < 16 || ascii(b, 4, 4) !== "ftyp") return null;
  let best: ImageSize | null = null;
  const walk = (start: number, end: number, path: string[]) => {
    let i = start;
    while (i + 8 <= end) {
      let size = u32(b, i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1) {
        // 64-bit size: anything past 4 GB is past this header slice anyway.
        if (i + 16 > end || u32(b, i + 8) !== 0) return;
        size = u32(b, i + 12);
        header = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < header) return;
      const boxEnd = Math.min(end, i + size);
      if (path.length === 0 && type === "meta") walk(i + header + 4, boxEnd, ["meta"]); // full box: skip version and flags
      else if (path.join("/") === "meta" && type === "iprp") walk(i + header, boxEnd, ["meta", "iprp"]);
      else if (path.join("/") === "meta/iprp" && type === "ipco") walk(i + header, boxEnd, ["meta", "iprp", "ipco"]);
      else if (path.join("/") === "meta/iprp/ipco" && type === "ispe" && i + header + 12 <= end) {
        const found = { width: u32(b, i + header + 4), height: u32(b, i + header + 8) };
        if (!best || found.width * found.height > best.width * best.height) best = found;
      }
      if (path.length === 0 && type === "mdat") return; // the pixels: the boxes that matter came first
      i += size;
    }
  };
  walk(0, b.length, []);
  return best;
}
