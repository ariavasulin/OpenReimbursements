import exifr from "exifr";

// Extract the EXIF capture time from an image file. Returns null when the
// file has no usable EXIF (videos, PNGs, canvas JPEGs, ...) — the server
// falls back to upload time when finalizing the row.
export async function extractCapturedAt(file: File | Blob): Promise<Date | null> {
  const mime = "type" in file ? file.type : "";
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
