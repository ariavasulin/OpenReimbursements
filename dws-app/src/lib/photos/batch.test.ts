import { describe, expect, it } from "vitest";
import { canRemove, nextPreviewIndex, removeAt } from "./batch";

const state = {
  files: ["a", "b", "c"],
  items: [{ status: "pending" }, { status: "failed" }, { status: "pending" }],
  previews: ["blob:a", null, "blob:c"],
};

describe("removeAt", () => {
  it("drops the same position from files, items, and previews", () => {
    const next = removeAt(state, 1);
    expect(next.files).toEqual(["a", "c"]);
    expect(next.items).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(next.previews).toEqual(["blob:a", "blob:c"]);
  });

  it("does not mutate the input", () => {
    removeAt(state, 0);
    expect(state.files).toEqual(["a", "b", "c"]);
    expect(state.previews).toEqual(["blob:a", null, "blob:c"]);
  });

  it("empties every array when the last file goes", () => {
    const one = { files: ["a"], items: [{ status: "pending" }], previews: [null] };
    expect(removeAt(one, 0)).toEqual({ files: [], items: [], previews: [] });
  });
});

describe("canRemove", () => {
  it("allows pending and failed, blocks uploading and done", () => {
    expect(canRemove("pending")).toBe(true);
    expect(canRemove("failed")).toBe(true);
    expect(canRemove("uploading")).toBe(false);
    expect(canRemove("done")).toBe(false);
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
