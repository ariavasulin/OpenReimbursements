import { describe, expect, it } from "vitest";
import { classifyFile, extensionOf, rewrap } from "./classify";

const file = (name: string, type = "", size = 4, lastModified = 1_000) =>
  new File([new Uint8Array(size)], name, { type, lastModified });

describe("extensionOf", () => {
  it("lowercases and handles dotless / hidden names", () => {
    expect(extensionOf("IMG_0001.JPG")).toBe("jpg");
    expect(extensionOf("clip.MOV")).toBe("mov");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
  });
});

describe("classifyFile", () => {
  it("classifies .xmp with an empty browser type as a sidecar", () => {
    const c = classifyFile(file("IMG_5011.xmp"));
    expect(c.kind).toBe("sidecar");
    expect(c.mime).toBe("application/rdf+xml");
  });

  it("classifies .MOV as video/quicktime even with the browser's type set", () => {
    const c = classifyFile(file("IMG_5011.MOV", "video/quicktime"));
    expect(c).toMatchObject({ kind: "video", mime: "video/quicktime", ext: "mov" });
  });

  it("classifies .heic as an image even when the browser leaves type empty", () => {
    expect(classifyFile(file("IMG_1.HEIC"))).toMatchObject({
      kind: "image",
      mime: "image/heic",
    });
  });

  it("keeps the browser mime for unknown extensions with a usable type", () => {
    expect(classifyFile(file("report.pdf", "application/pdf"))).toMatchObject({
      kind: "file",
      mime: "application/pdf",
    });
  });

  it("falls back to the File.type prefix, then octet-stream", () => {
    expect(classifyFile(file("shot.cr3", "image/x-canon-cr3")).kind).toBe(
      "image"
    );
    expect(classifyFile(file("shot.cr3"))).toMatchObject({
      kind: "file",
      mime: "application/octet-stream",
    });
  });
});

describe("rewrap", () => {
  it("preserves size, name, and lastModified while setting the type", () => {
    const original = file("IMG_1.MOV", "", 10, 777);
    const wrapped = rewrap(original, "video/quicktime");
    expect(wrapped.type).toBe("video/quicktime");
    expect(wrapped.name).toBe("IMG_1.MOV");
    expect(wrapped.size).toBe(10);
    expect(wrapped.lastModified).toBe(777);
  });

  it("returns the same File when the type already matches", () => {
    const original = file("a.jpg", "image/jpeg");
    expect(rewrap(original, "image/jpeg")).toBe(original);
  });
});
