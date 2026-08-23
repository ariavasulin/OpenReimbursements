import { describe, expect, it } from "vitest";
import { nextPreviewIndex } from "./batch";

describe("nextPreviewIndex", () => {
  it("stays put when a later file is removed", () => {
    expect(nextPreviewIndex(0, 2, 2)).toBe(0);
  });
  it("shifts back when an earlier file is removed", () => {
    expect(nextPreviewIndex(2, 0, 2)).toBe(1);
  });
  it("clamps when the viewed (last) file is removed", () => {
    expect(nextPreviewIndex(2, 2, 2)).toBe(1);
  });
  it("is null when nothing remains", () => {
    expect(nextPreviewIndex(0, 0, 0)).toBeNull();
  });
});
