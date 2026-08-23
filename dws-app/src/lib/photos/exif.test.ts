import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCapturedAt, readExifDate } from "./exif";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name));

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
    const result = await extractCapturedAt(png(5_000), {
      sidecarDate,
      shutter: new Date("2020-01-01T00:00:00Z"),
    });
    expect(result).toEqual({ date: sidecarDate, source: "xmp" });
  });

  it("uses the in-app shutter time when there is no EXIF, source 'camera'", async () => {
    const shutter = new Date("2020-01-01T00:00:00Z");
    const result = await extractCapturedAt(png(5_000), { shutter });
    expect(result).toEqual({ date: shutter, source: "camera" });
  });

  it("falls back to lastModified, source 'file'", async () => {
    const result = await extractCapturedAt(png(5_000));
    expect(result).toEqual({ date: new Date(5_000), source: "file" });
  });

  it("videos land on lastModified without being read", async () => {
    const file = new File([new Uint8Array(64)], "clip.mp4", {
      type: "video/mp4",
      lastModified: 9_000,
    });
    const result = await extractCapturedAt(file);
    expect(result).toEqual({ date: new Date(9_000), source: "file" });
  });

  it("no date at all (lastModified 0) → null with source 'upload'", async () => {
    const result = await extractCapturedAt(png(0));
    expect(result).toEqual({ date: null, source: "upload" });
  });
});
