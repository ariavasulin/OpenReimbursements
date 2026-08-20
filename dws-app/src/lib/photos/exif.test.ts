import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCapturedAt } from "./exif";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name));

describe("extractCapturedAt", () => {
  it("returns the EXIF DateTimeOriginal from a JPEG", async () => {
    const file = new File([fixture("exif-datetime.jpg")], "photo.jpg", {
      type: "image/jpeg",
    });
    const capturedAt = await extractCapturedAt(file);
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
    expect(await extractCapturedAt(file)).toBeNull();
  });

  it("returns null for videos without reading them", async () => {
    const file = new File([new Uint8Array(64)], "clip.mp4", {
      type: "video/mp4",
    });
    expect(await extractCapturedAt(file)).toBeNull();
  });

  it("returns null instead of throwing on garbage bytes", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "junk.jpg", {
      type: "image/jpeg",
    });
    expect(await extractCapturedAt(file)).toBeNull();
  });
});
