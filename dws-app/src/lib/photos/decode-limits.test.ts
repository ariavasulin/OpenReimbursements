import { describe, expect, it } from "vitest";
import { canDecodePreview, DERIVATIVES_MAX_BYTES } from "./decode-limits";

describe("selection and upload decode budget", () => {
  it("keeps normal phone media previewable and skips oversized originals", () => {
    expect(canDecodePreview({ name: "phone.jpg", size: DERIVATIVES_MAX_BYTES })).toBe(true);
    expect(canDecodePreview({ name: "large.jpg", size: DERIVATIVES_MAX_BYTES + 1 })).toBe(false);
    expect(canDecodePreview({ name: "large.mp4", size: 101 * 1024 * 1024 })).toBe(false);
  });
  it.each(["tif", "tiff", "dng", "cr2", "nef", "arw"])("skips %s decoding regardless of compressed file size", (ext) => {
    expect(canDecodePreview({ name: `raw.${ext.toUpperCase()}`, size: 1024 })).toBe(false);
  });
});
