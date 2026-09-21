import { describe, expect, it } from "vitest";
import {
  addToSelection, MAX_SELECTION, selectionLimitMessage, selectionRange, toggleGroupSelection, toggleSelection,
} from "./selection";

const ids = ["a", "b", "c", "d", "e"];

describe("selectionRange", () => {
  it("selects from the anchor to the target, both ends included, in either direction", () => {
    expect(selectionRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectionRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(selectionRange(ids, "c", "c")).toEqual(["c"]);
  });

  it("falls back to the target alone without a usable anchor", () => {
    expect(selectionRange(ids, null, "d")).toEqual(["d"]);
    expect(selectionRange(ids, "gone", "d")).toEqual(["d"]);
    expect(selectionRange(ids, "a", "gone")).toEqual([]);
  });

  it("names each photo once when tag groups repeat it", () => {
    expect(selectionRange(["a", "b", "a", "c"], "a", "c")).toEqual(["a", "b", "c"]);
  });
});

describe("selection changes", () => {
  it("ticks on and off", () => {
    const on = toggleSelection(new Set(), "a");
    expect([...on.selected]).toEqual(["a"]);
    expect([...toggleSelection(on.selected, "a").selected]).toEqual([]);
  });

  it("refuses what does not fit and says how many", () => {
    const full = new Set(["a", "b"]);
    expect(toggleSelection(full, "c", 2)).toEqual({ selected: full, refused: 1 });
    const partly = addToSelection(new Set(["a"]), ["a", "b", "c", "d"], 3);
    expect([...partly.selected]).toEqual(["a", "b", "c"]);
    expect(partly.refused).toBe(1);
    // Un-ticking always works at the limit.
    expect([...toggleSelection(full, "a", 2).selected]).toEqual(["b"]);
  });

  it("limits a selection to the bulk routes' 500", () => {
    const many = Array.from({ length: 501 }, (_, index) => `photo-${index}`);
    const result = addToSelection(new Set(), many);
    expect(MAX_SELECTION).toBe(500);
    expect(result.selected.size).toBe(500);
    expect(result.refused).toBe(1);
    expect(selectionLimitMessage()).toContain("up to 500 photos");
  });

  it("a group tick selects the whole group, and clears it when all of it is already selected", () => {
    const some = toggleGroupSelection(new Set(["a"]), ["a", "b", "c"]);
    expect([...some.selected]).toEqual(["a", "b", "c"]);
    expect([...toggleGroupSelection(new Set(["a", "b", "c", "z"]), ["a", "b", "c"]).selected]).toEqual(["z"]);
    expect([...toggleGroupSelection(new Set(["z"]), []).selected]).toEqual(["z"]);
  });
});
