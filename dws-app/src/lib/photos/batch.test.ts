import { describe, expect, it } from "vitest";
import { nextPreviewIndex, removeAt } from "./batch";

const f = (name: string) => new File([], name);
const files = [f("a"), f("b"), f("c")];
const previews = ["blob:a", null, "blob:c"];

describe("removeAt", () => {
  it("drops the same position from files and previews", () => {
    const next = removeAt(files, previews, 1);
    expect(next.files.map((file) => file.name)).toEqual(["a", "c"]);
    expect(next.previews).toEqual(["blob:a", "blob:c"]);
  });

  it("does not mutate the input", () => {
    removeAt(files, previews, 0);
    expect(files.map((file) => file.name)).toEqual(["a", "b", "c"]);
    expect(previews).toEqual(["blob:a", null, "blob:c"]);
  });

  it("empties both arrays when the last file goes", () => {
    expect(removeAt([f("a")], [null], 0)).toEqual({ files: [], previews: [] });
  });
});

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
