import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exceedsPreviewPixels, parseImageSize, PREVIEW_MAX_PIXELS, readImageSize } from "./image-size";

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "__fixtures__", name)));
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, body: number[]) => [...be32(8 + body.length), ...text(type), ...body];
const ispe = (width: number, height: number) => box("ispe", [0, 0, 0, 0, ...be32(width), ...be32(height)]);

describe("image size from the header", () => {
  it("reads real JPEG and PNG fixtures", async () => {
    expect(parseImageSize(fixture("exif-datetime.jpg"))).toEqual({ width: 32, height: 24 });
    expect(parseImageSize(fixture("no-exif.png"))).toEqual({ width: 16, height: 16 });
    await expect(readImageSize(new Blob([fixture("no-exif.png")]))).resolves.toEqual({ width: 16, height: 16 });
  });

  it("skips the EXIF block, so its small preview JPEG is not taken for the photo", () => {
    const embedded = [0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(120), ...be16(160), 3, ...Array(9).fill(0)];
    const app1 = [0xff, 0xe1, ...be16(2 + embedded.length), ...embedded];
    const sof = [0xff, 0xc2, ...be16(17), 8, ...be16(6048), ...be16(8064), 3, ...Array(9).fill(0)];
    expect(parseImageSize(new Uint8Array([0xff, 0xd8, ...app1, ...sof]))).toEqual({ width: 8064, height: 6048 });
  });

  it("reads the three WebP layouts", () => {
    const riff = (chunk: string, body: number[]) => new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), 0, 0, 0, 0, ...body, ...Array(16).fill(0)]);
    // VP8X: 24-bit width-1 and height-1 after 4 flag bytes.
    expect(parseImageSize(riff("VP8X", [0, 0, 0, 0, 0x3f, 0x1f, 0, 0xbf, 0x17, 0]))).toEqual({ width: 8000, height: 6080 });
    // VP8 (lossy): 14-bit sizes after the frame tag and start code.
    expect(parseImageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]))).toEqual({ width: 640, height: 480 });
    // VP8L (lossless): signature byte, then 14 + 14 bits of size minus one.
    const bits = (640 - 1) | ((480 - 1) << 14);
    expect(parseImageSize(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({ width: 640, height: 480 });
  });

  it("takes the largest ispe of a HEIC: the whole photo, not a tile or the thumbnail", () => {
    const ipco = box("ipco", [...ispe(512, 512), ...ispe(8064, 6048), ...ispe(320, 240)]);
    const meta = box("meta", [0, 0, 0, 0, ...box("hdlr", Array(24).fill(0)), ...box("iprp", [...ipco, ...box("ipma", Array(8).fill(0))])]);
    const heic = new Uint8Array([...box("ftyp", [...text("heic"), 0, 0, 0, 0, ...text("mif1heic")]), ...meta, ...box("mdat", Array(16).fill(0))]);
    expect(parseImageSize(heic)).toEqual({ width: 8064, height: 6048 });
  });

  it("answers null for unknown, truncated, or corrupt headers", () => {
    expect(parseImageSize(new Uint8Array(text("not an image at all")))).toBeNull();
    expect(parseImageSize(fixture("exif-datetime.jpg").subarray(0, 40))).toBeNull();
    expect(parseImageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, ...Array(20).fill(0)]))).toBeNull();
    expect(parseImageSize(new Uint8Array([...box("ftyp", text("heic")), ...be32(3), ...text("meta")]))).toBeNull();
  });

  it("flags only a header that names more than the pixel limit", async () => {
    const jpeg = (width: number, height: number) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, ...Array(9).fill(0)])]);
    await expect(exceedsPreviewPixels(jpeg(8064, 6048))).resolves.toBe(true);
    await expect(exceedsPreviewPixels(jpeg(5712, 4284))).resolves.toBe(false); // 24 MP
    await expect(exceedsPreviewPixels(new Blob(["?"]))).resolves.toBe(false);
    expect(PREVIEW_MAX_PIXELS).toBe(40_000_000);
  });
});
