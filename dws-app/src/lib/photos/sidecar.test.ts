import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pairByBasename, readSidecarMeta } from "./sidecar";

const f = (name: string, type = "") =>
  new File([new Uint8Array(4)], name, { type });

describe("pairByBasename", () => {
  it("pairs an image with its .xmp case-insensitively", () => {
    const { pairs, rejected } = pairByBasename([
      f("IMG_1.JPG", "image/jpeg"),
      f("img_1.xmp"),
    ]);
    expect(rejected).toEqual([]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].primary.file.name).toBe("IMG_1.JPG");
    expect(pairs[0].sidecar?.file.name).toBe("img_1.xmp");
  });

  it("rejects a lone .xmp with a reason naming the missing partner", () => {
    const { pairs, rejected } = pairByBasename([f("IMG_5011.xmp")]);
    expect(pairs).toEqual([]);
    expect(rejected).toEqual([
      {
        name: "IMG_5011.xmp",
        reason: "needs img_5011.<image> in the same upload",
      },
    ]);
  });

  it("rejects a second .xmp for the same image", () => {
    const { pairs, rejected } = pairByBasename([
      f("a.jpg", "image/jpeg"),
      f("A.xmp"),
      f("a.xmp"),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sidecar?.file.name).toBe("A.xmp");
    expect(rejected.map((r) => r.name)).toEqual(["a.xmp"]);
  });

  it("only images own sidecars — a video's .xmp is rejected", () => {
    const { pairs, rejected } = pairByBasename([
      f("clip.mov", "video/quicktime"),
      f("clip.xmp"),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sidecar).toBeUndefined();
    expect(rejected.map((r) => r.name)).toEqual(["clip.xmp"]);
  });

  it("keeps non-sidecar files as primaries in pick order", () => {
    const { pairs } = pairByBasename([
      f("b.pdf", "application/pdf"),
      f("a.jpg", "image/jpeg"),
    ]);
    expect(pairs.map((p) => p.primary.file.name)).toEqual(["b.pdf", "a.jpg"]);
  });
});

describe("readSidecarMeta", () => {
  const fixture = () =>
    new File(
      [readFileSync(join(__dirname, "__fixtures__", "sample.xmp"))],
      "sample.xmp"
    );

  it("reads exif:DateTimeOriginal and dc:subject keywords from a packet", async () => {
    const meta = await readSidecarMeta(fixture());
    expect(meta.capturedAt).toBeInstanceOf(Date);
    // Fixture carries 2026-08-14T14:41:00 (no offset -> local time).
    expect(meta.capturedAt!.getFullYear()).toBe(2026);
    expect(meta.capturedAt!.getMonth()).toBe(7); // August
    expect(meta.capturedAt!.getDate()).toBe(14);
    expect(meta.capturedAt!.getHours()).toBe(14);
    expect(meta.capturedAt!.getMinutes()).toBe(41);
    expect(meta.keywords).toEqual(["site-visit", "plumbing"]);
  });

  it("yields nothing (never throws) for a file that isn't XMP", async () => {
    const meta = await readSidecarMeta(f("junk.xmp"));
    expect(meta).toEqual({ capturedAt: null, keywords: [] });
  });
});
