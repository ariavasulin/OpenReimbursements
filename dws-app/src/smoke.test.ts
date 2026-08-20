// @vitest-environment jsdom
// Phase 0 toolchain smoke test: proves vitest + jsdom run in this repo.
// Real photo-hub tests (middleware, upload, exif, derivatives) land in later phases.
import { describe, expect, it } from "vitest";

describe("test toolchain", () => {
  it("runs assertions", () => {
    expect(1 + 1).toBe(2);
  });

  it("has a DOM available via jsdom", () => {
    const el = document.createElement("div");
    el.textContent = "ok";
    expect(el.textContent).toBe("ok");
  });
});
