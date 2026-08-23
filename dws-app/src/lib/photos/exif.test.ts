import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCapturedAt, readExifDate } from "./exif";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name));

/** The JPEG fixture's DateTimeOriginal is a fixed-width 19-byte ASCII field,
 * so a date variant is a byte swap in place rather than another checked-in
 * binary. */
const FIXTURE_EXIF_DATE = "2026:08:14 14:41:00";
function jpegWithExifDate(value: string): Buffer {
  const bytes = fixture("exif-datetime.jpg");
  const at = bytes.indexOf(FIXTURE_EXIF_DATE, 0, "latin1");
  if (at < 0 || value.length !== FIXTURE_EXIF_DATE.length) {
    throw new Error("fixture no longer patchable");
  }
  Buffer.from(value, "latin1").copy(bytes, at);
  return bytes;
}
const jpegFile = (value: string, lastModified = 0) =>
  new File([jpegWithExifDate(value)], "photo.jpg", {
    type: "image/jpeg",
    lastModified,
  });

// A plausible camera-roll mtime: past, and comfortably after the 1990 floor.
const PLAUSIBLE_MTIME = Date.UTC(2026, 7, 14, 21, 41);

describe("readExifDate", () => {
  it("returns the EXIF DateTimeOriginal from a JPEG", async () => {
    const file = new File([fixture("exif-datetime.jpg")], "photo.jpg", {
      type: "image/jpeg",
    });
    const capturedAt = await readExifDate(file);
    expect(capturedAt).toBeInstanceOf(Date);
    // Fixture carries DateTimeOriginal 2026:08:14 14:41:00 (local time).
    expect(capturedAt!.getFullYear()).toBe(2026);
    expect(capturedAt!.getMonth()).toBe(7); // August
    expect(capturedAt!.getDate()).toBe(14);
    expect(capturedAt!.getHours()).toBe(14);
    expect(capturedAt!.getMinutes()).toBe(41);
  });

  it("returns null for an image without EXIF", async () => {
    const file = new File([fixture("no-exif.png")], "plain.png", {
      type: "image/png",
    });
    expect(await readExifDate(file)).toBeNull();
  });

  it("returns null for videos without reading them", async () => {
    const file = new File([new Uint8Array(64)], "clip.mp4", {
      type: "video/mp4",
    });
    expect(await readExifDate(file)).toBeNull();
  });

  it("returns null instead of throwing on garbage bytes", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "junk.jpg", {
      type: "image/jpeg",
    });
    expect(await readExifDate(file)).toBeNull();
  });

  it("returns null for the zeroed EXIF date, not 1899", async () => {
    expect(await readExifDate(jpegFile("0000:00:00 00:00:00"))).toBeNull();
  });

  it("returns null for a date far in the future", async () => {
    expect(await readExifDate(jpegFile("2099:01:01 00:00:00"))).toBeNull();
  });
});

describe("extractCapturedAt (provenance)", () => {
  const png = (lastModified: number) =>
    new File([fixture("no-exif.png")], "plain.png", {
      type: "image/png",
      lastModified,
    });

  it("EXIF wins over every fallback, source 'exif'", async () => {
    const file = new File([fixture("exif-datetime.jpg")], "photo.jpg", {
      type: "image/jpeg",
      lastModified: 5_000,
    });
    const result = await extractCapturedAt(file, {
      shutter: new Date("2020-01-01T00:00:00Z"),
      sidecarDate: new Date("2021-01-01T00:00:00Z"),
    });
    expect(result.source).toBe("exif");
    expect(result.date!.getFullYear()).toBe(2026);
  });

  it("uses the XMP sidecar date before the shutter, source 'xmp'", async () => {
    const sidecarDate = new Date("2021-01-01T00:00:00Z");
    const result = await extractCapturedAt(png(PLAUSIBLE_MTIME), {
      sidecarDate,
      shutter: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result).toEqual({ date: sidecarDate, source: "xmp" });
  });

  it("uses the in-app shutter time when there is no EXIF, source 'camera'", async () => {
    const shutter = new Date("2020-01-01T00:00:00Z");
    const result = await extractCapturedAt(png(PLAUSIBLE_MTIME), { shutter });
    expect(result).toEqual({ date: shutter, source: "camera" });
  });

  it("falls back to lastModified, source 'file'", async () => {
    const result = await extractCapturedAt(png(PLAUSIBLE_MTIME));
    expect(result).toEqual({ date: new Date(PLAUSIBLE_MTIME), source: "file" });
  });

  it("videos land on lastModified without being read", async () => {
    const file = new File([new Uint8Array(64)], "clip.mp4", {
      type: "video/mp4",
      lastModified: PLAUSIBLE_MTIME,
    });
    const result = await extractCapturedAt(file);
    expect(result).toEqual({ date: new Date(PLAUSIBLE_MTIME), source: "file" });
  });

  it("no date at all (lastModified 0) → null with source 'upload'", async () => {
    const result = await extractCapturedAt(png(0));
    expect(result).toEqual({ date: null, source: "upload" });
  });

  it("a zeroed EXIF date falls through to the sidecar rung", async () => {
    const sidecarDate = new Date("2021-01-01T00:00:00Z");
    const result = await extractCapturedAt(
      jpegFile("0000:00:00 00:00:00", PLAUSIBLE_MTIME),
      { sidecarDate }
    );
    expect(result).toEqual({ date: sidecarDate, source: "xmp" });
  });

  it("a far-future EXIF date falls through to lastModified", async () => {
    const result = await extractCapturedAt(
      jpegFile("2099:01:01 00:00:00", PLAUSIBLE_MTIME)
    );
    expect(result).toEqual({ date: new Date(PLAUSIBLE_MTIME), source: "file" });
  });

  it("an implausible lastModified is dropped too, source 'upload'", async () => {
    const preFloor = await extractCapturedAt(png(Date.UTC(1989, 11, 31)));
    expect(preFloor).toEqual({ date: null, source: "upload" });
    const farFuture = await extractCapturedAt(png(Date.UTC(2099, 0, 1)));
    expect(farFuture).toEqual({ date: null, source: "upload" });
  });
});
