// Its own file: the mock below replaces the full exifr build for every test
// in the file, and exif.test.ts needs the real one.
import { describe, expect, it, vi } from "vitest";
import { ExifReaderUnavailableError, extractCapturedAt, readExifDate } from "./exif";

const CHUNK = "https://photos.example/_next/static/chunks/exifr.abc.js";
// What webpack rejects a failed code download with.
vi.mock("exifr", () => {
  throw Object.assign(new Error(`Loading chunk 123 failed.\n(error: ${CHUNK})`), { name: "ChunkLoadError", request: CHUNK });
});

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png", lastModified: Date.UTC(2026, 9, 1) });
const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "shot.jpg", { type: "image/jpeg", lastModified: Date.UTC(2026, 9, 1) });

describe("a PNG whose reader could not be downloaded", () => {
  it("readExifDate throws ExifReaderUnavailableError, not null", async () => {
    await expect(readExifDate(png())).rejects.toBeInstanceOf(ExifReaderUnavailableError);
  });

  it("extractCapturedAt does not fall back to the file's date", async () => {
    await expect(extractCapturedAt(png())).rejects.toBeInstanceOf(ExifReaderUnavailableError);
  });

  it("the error reads as a dropped connection to the upload, and carries the download failure", async () => {
    const error = await readExifDate(png()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network_error", retryable: true });
    // The cause is what the import rejected with (here vitest's wrapper around the chunk error).
    expect((error as ExifReaderUnavailableError).cause).toBeInstanceOf(Error);
    expect(JSON.stringify((error as ExifReaderUnavailableError).cause, Object.getOwnPropertyNames((error as ExifReaderUnavailableError).cause))).toContain("Loading chunk 123 failed");
  });

  it("a JPEG still reads with the lite build (no download needed)", async () => {
    await expect(extractCapturedAt(jpeg())).resolves.toMatchObject({ source: "file" });
  });
});
