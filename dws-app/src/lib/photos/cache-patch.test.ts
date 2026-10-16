import { describe, expect, it } from "vitest";
import { applyTagChange, editGrid, isCachedGrid, listFiltersByTag, MAX_PHOTO_TAGS, type CachedGrid } from "./cache-patch";
import type { PhotoRow } from "./types";

const row = (id: string, tags: string[] = []) => ({ id, tags }) as unknown as PhotoRow;
const grid = (...pages: PhotoRow[][]): CachedGrid => ({
  pages: pages.map((photos, index) => ({ photos, nextCursor: index < pages.length - 1 ? `c${index}` : null })),
  pageParams: pages.map((_, index) => (index === 0 ? null : `c${index - 1}`)),
});

describe("isCachedGrid", () => {
  it("tells a grid's pages from the Select all answers kept under the same prefix", () => {
    expect(isCachedGrid(grid([row("a")]))).toBe(true);
    expect(isCachedGrid({ ids: ["a"], total: 1, truncated: false })).toBe(false);
    expect(isCachedGrid(12)).toBe(false);
    expect(isCachedGrid(undefined)).toBe(false);
  });
});

describe("editGrid", () => {
  it("returns the same grid and pages when nothing changes, so memoised tiles keep", () => {
    const before = grid([row("a"), row("b")], [row("c")]);
    expect(editGrid(before, (photo) => photo)).toBe(before);
  });

  it("replaces and removes rows, keeps untouched pages and every cursor", () => {
    const before = grid([row("a"), row("b")], [row("c")]);
    const after = editGrid(before, (photo) => (photo.id === "a" ? null : photo.id === "b" ? row("b", ["x"]) : photo));
    expect(after.pages[0].photos.map((photo) => [photo.id, photo.tags])).toEqual([["b", ["x"]]]);
    expect(after.pages[0].nextCursor).toBe("c0");
    expect(after.pages[1]).toBe(before.pages[1]);
    expect(after.pageParams).toBe(before.pageParams);
  });
});

describe("applyTagChange (mirrors photo_bulk_tag)", () => {
  it("adds once, ignoring case, and keeps the order", () => {
    expect(applyTagChange(["Shop"], { add: ["field", "SHOP"] })).toEqual(["Shop", "field"]);
  });

  it("takes the library's spelling for a new tag", () => {
    expect(applyTagChange([], { add: ["Kitchen"] }, ["kitchen", "Shop"])).toEqual(["kitchen"]);
  });

  it("removes ignoring case", () => {
    expect(applyTagChange(["Shop", "Field"], { remove: ["shop"] })).toEqual(["Field"]);
  });

  it("hands back the very same array when nothing changes", () => {
    const tags = ["Shop"];
    expect(applyTagChange(tags, { add: ["shop"] })).toBe(tags);
    expect(applyTagChange(tags, { remove: ["Field"] })).toBe(tags);
  });

  it("is null (skipped) when the change would push a photo past the limit", () => {
    const full = Array.from({ length: MAX_PHOTO_TAGS }, (_, index) => `t${index}`);
    expect(applyTagChange(full, { add: ["one more"] })).toBeNull();
    // Removing at the same time to stay within the limit is fine.
    expect(applyTagChange(full, { add: ["one more"], remove: ["t0"] })).toHaveLength(MAX_PHOTO_TAGS);
  });
});

describe("listFiltersByTag", () => {
  it("reads a grid key's list parameters", () => {
    expect(listFiltersByTag("job=1&tags=Shop")).toBe(true);
    expect(listFiltersByTag("job=1")).toBe(false);
    expect(listFiltersByTag(undefined)).toBe(false);
  });
});
