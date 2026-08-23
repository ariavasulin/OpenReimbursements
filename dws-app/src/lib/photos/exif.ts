import exifr from "exifr";
import type { CapturedAtSource } from "./types";

/** A capture time plus where it came from (see CapturedAtSource). */
export interface CapturedAt {
  date: Date | null;
  source: CapturedAtSource;
}

/** Earliest date we'll believe as a photograph's capture time. Anything older
 * is a placeholder, not a date: exifr's reviveDate turns the canonical unset
 * EXIF value "0000:00:00 00:00:00" into a *valid* Date at 1899-11-30, and a
 * zeroed filesystem timestamp lands on the 1970 epoch. */
const EARLIEST_CAPTURE_MS = Date.UTC(1990, 0, 1);
/** Slack on the upper bound, for clock skew and for a camera whose EXIF is
 * stamped in a timezone ahead of the browser's. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** True when `date` could plausibly be when a photo was taken. A value
 * outside the range is dropped so the provenance chain falls through to the
 * next rung instead of publishing a bogus date as an authoritative one. */
function isPlausibleCapture(date: Date): boolean {
  const ms = date.getTime();
  if (Number.isNaN(ms)) return false;
  return ms >= EARLIEST_CAPTURE_MS && ms <= Date.now() + FUTURE_SLACK_MS;
}

// Read the EXIF capture time from an image file. Returns null when the file
// has no usable EXIF (videos, PNGs, canvas JPEGs, ...) or when the date it
// carries is not a plausible capture time.
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
    if (candidate instanceof Date && isPlausibleCapture(candidate)) {
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
 * finalizes as upload time (source 'upload'). The EXIF and lastModified rungs
 * skip an implausible date (see EARLIEST_CAPTURE_MS); the sidecar and shutter
 * dates are taken as given.
 */
export async function extractCapturedAt(
  file: File,
  opts: { shutter?: Date; sidecarDate?: Date | null } = {}
): Promise<CapturedAt> {
  const exif = await readExifDate(file);
  if (exif) return { date: exif, source: "exif" };
  if (opts.sidecarDate) return { date: opts.sidecarDate, source: "xmp" };
  if (opts.shutter) return { date: opts.shutter, source: "camera" };
  const modified = new Date(file.lastModified);
  if (isPlausibleCapture(modified)) {
    return { date: modified, source: "file" };
  }
  return { date: null, source: "upload" };
}
