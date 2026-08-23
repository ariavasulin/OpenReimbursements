import exifr from "exifr";
import type { CapturedAtSource } from "./types";

export type { CapturedAtSource };

/** A capture time plus where it came from (see CapturedAtSource). */
export interface CapturedAt {
  date: Date | null;
  source: CapturedAtSource;
}

// Read the EXIF capture time from an image file. Returns null when the file
// has no usable EXIF (videos, PNGs, canvas JPEGs, ...).
export async function readExifDate(file: File | Blob): Promise<Date | null> {
  const mime = file.type;
  // exifr only reads photo metadata; skip videos and other non-images outright
  // (never pull a multi-GB video into memory looking for EXIF it can't have).
  if (mime && !mime.startsWith("image/")) return null;

  try {
    // In the browser exifr reads the File in chunks; in Node (tests) it needs
    // a byte buffer.
    const source =
      typeof FileReader === "undefined"
        ? new Uint8Array(await file.arrayBuffer())
        : file;
    const parsed = (await exifr.parse(source, [
      "DateTimeOriginal",
      "CreateDate",
    ])) as { DateTimeOriginal?: unknown; CreateDate?: unknown } | undefined;

    const candidate = parsed?.DateTimeOriginal ?? parsed?.CreateDate;
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best available capture time with explicit provenance. Priority: EXIF →
 * XMP sidecar → in-app camera shutter → file.lastModified (for a camera-roll
 * pick this is usually the real capture time) → null, which the server
 * finalizes as upload time (source 'upload').
 */
export async function extractCapturedAt(
  file: File,
  opts: { shutter?: Date; sidecarDate?: Date | null } = {}
): Promise<CapturedAt> {
  const exif = await readExifDate(file);
  if (exif) return { date: exif, source: "exif" };
  if (opts.sidecarDate) return { date: opts.sidecarDate, source: "xmp" };
  if (opts.shutter) return { date: opts.shutter, source: "camera" };
  if (file.lastModified > 0) {
    return { date: new Date(file.lastModified), source: "file" };
  }
  return { date: null, source: "upload" };
}
