import { describe, expect, it } from "vitest";
import { selectAllLabel, selectAllNeedsIds } from "./select-all";
import { MAX_SELECTION } from "./selection";

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const loadedMap = (list: string[]) => new Map(list.map((id) => [id, null]));

describe("selectAllLabel (the selection bar's Select all link)", () => {
  it("waits for the count", () => {
    expect(selectAllLabel(new Set(["a"]), undefined, loadedMap(["a"]))).toBeNull();
  });

  it("offers every match while some are not selected", () => {
    const loaded = loadedMap(ids("p", 100));
    expect(selectAllLabel(new Set(["p0", "p1"]), 250, loaded)).toBe("Select all 250");
  });

  it("hides when the selection holds as many as match", () => {
    const loaded = ids("p", 3);
    expect(selectAllLabel(new Set(loaded), 3, loadedMap(loaded))).toBeNull();
    // Ticked past the loaded pages (a group tick): 120 selected of 120 matches.
    expect(selectAllLabel(new Set(ids("p", 120)), 120, loadedMap(ids("p", 100)))).toBeNull();
  });

  it("still offers the matches when the selection came from another filter", () => {
    // Ten ticked in project A, then filtered to project B: 8 photos, 2 of them ticked.
    const projectB = ids("b", 8);
    const selected = new Set([...ids("a", 10), "b0", "b1"]);
    expect(selectAllLabel(selected, 8, loadedMap(projectB))).toBe("Select all 8");
    expect(selectAllLabel(new Set([...ids("a", 10), ...projectB]), 8, loadedMap(projectB))).toBeNull();
  });

  it("asks for the ids when the count cannot tell, and offers the matches still unticked", () => {
    // 150 ticked under filter A, then filtered to B (250 matches, 100 loaded) and its loaded 100 ticked.
    const loadedB = ids("b", 100);
    const selected = new Set([...ids("a", 150), ...loadedB]);
    const loaded = loadedMap(loadedB);
    expect(selectAllNeedsIds(selected, 250, loaded)).toBe(true);
    expect(selectAllLabel(selected, 250, loaded)).toBeNull();
    expect(selectAllLabel(selected, 250, loaded, ids("b", 250))).toBe("Select all 250");
    // After Select all, every match is in the selection: the ids say so.
    const all = new Set([...selected, ...ids("b", 250)]);
    expect(selectAllLabel(all, 250, loaded, ids("b", 250))).toBeNull();
  });

  it("needs no ids when the count settles it", () => {
    const loaded = loadedMap(ids("p", 100));
    expect(selectAllNeedsIds(new Set(["p0"]), 250, loaded)).toBe(false);
    expect(selectAllNeedsIds(new Set(ids("p", 3)), 3, loadedMap(ids("p", 3)))).toBe(false);
    expect(selectAllNeedsIds(new Set(["p0"]), undefined, loaded)).toBe(false);
  });

  it("says how far it goes past the selection limit", () => {
    expect(selectAllLabel(new Set(["p0"]), 12_345, loadedMap(ids("p", 100)))).toBe(
      `Select all ${MAX_SELECTION.toLocaleString("en-US")} (of 12,345)`
    );
  });

  it("hides once the selection is full", () => {
    expect(selectAllLabel(new Set(ids("p", MAX_SELECTION)), MAX_SELECTION + 10, new Map())).toBeNull();
  });
});
