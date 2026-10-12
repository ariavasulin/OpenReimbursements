import { describe, expect, it } from "vitest";
import { fileTypeLabel } from "./file-type";
import type { PhotoKind } from "./types";

const label = (original_name: string | null, mime_type: string | null, kind: PhotoKind = "image") =>
  fileTypeLabel({ original_name, mime_type, kind });

describe("fileTypeLabel", () => {
  it("names the common image formats by extension, ignoring case", () => {
    expect(label("IMG_1.JPG", "image/jpeg")).toBe("JPEG");
    expect(label("a.jpeg", null)).toBe("JPEG");
    expect(label("IMG_2.HEIC", "image/heic")).toBe("HEIC");
    expect(label("b.heif", null)).toBe("HEIC");
    expect(label("plan.png", "image/png")).toBe("PNG");
  });

  it("groups every camera raw format and TIFF as RAW, even when the browser called it a file", () => {
    for (const name of ["a.dng", "a.CR2", "a.cr3", "a.nef", "a.arw", "a.tif", "a.TIFF"]) {
      expect(label(name, null, "file"), name).toBe("RAW");
    }
  });

  it("falls back to the MIME type when the name has no known extension", () => {
    expect(label("photo", "image/jpeg")).toBe("JPEG");
    expect(label(null, "image/x-sony-arw")).toBe("RAW");
    expect(label(null, "IMAGE/PNG")).toBe("PNG");
  });

  it("calls every video Video, by kind or by MIME type", () => {
    expect(label("clip.mov", "video/quicktime", "video")).toBe("Video");
    expect(label("clip.mp4", "video/mp4", "file")).toBe("Video");
  });

  it("calls everything else Other", () => {
    expect(label("drawing.pdf", "application/pdf", "file")).toBe("Other");
    expect(label("anim.gif", "image/gif")).toBe("Other");
    expect(label("x.webp", "image/webp")).toBe("Other");
    expect(label(null, null, "file")).toBe("Other");
  });
});
