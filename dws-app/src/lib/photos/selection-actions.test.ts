import { describe, expect, it } from "vitest";
import { desktopActions, fitActions, phoneActions, PHONE_SLOTS, selectionActions } from "./selection-actions";

describe("selectionActions", () => {
  it("offers the same actions in the same order everywhere", () => {
    expect(selectionActions({ inAlbum: false, count: 3 })).toEqual(["download", "album", "tag", "favorite", "project"]);
  });
  it("adds Remove from album inside an album, next to Add to album", () => {
    expect(selectionActions({ inAlbum: true, count: 3 })).toEqual(["download", "album", "remove", "tag", "favorite", "project"]);
  });
  it("adds Rename for exactly one photo, last", () => {
    expect(selectionActions({ inAlbum: true, count: 1 })).toEqual([
      "download", "album", "remove", "tag", "favorite", "project", "rename",
    ]);
    expect(selectionActions({ inAlbum: false, count: 2 })).not.toContain("rename");
  });
});

describe("phoneActions (bottom row of PHONE_SLOTS, Trash included)", () => {
  const slotsUsed = (fit: { shown: string[]; more: string[] }, trash: boolean) =>
    fit.shown.length + (fit.more.length > 0 ? 1 : 0) + (trash ? 1 : 0);

  it("folds Set project and Favorite into More when five do not fit beside Trash", () => {
    const fit = phoneActions(selectionActions({ inAlbum: false, count: 3 }), true);
    expect(fit).toEqual({ shown: ["download", "album", "tag"], more: ["favorite", "project"] });
    expect(slotsUsed(fit, true)).toBe(PHONE_SLOTS);
  });
  it("in an album with Trash, folds Set project then Tag into More, keeping Remove from album", () => {
    const fit = phoneActions(selectionActions({ inAlbum: true, count: 3 }), true);
    expect(fit).toEqual({ shown: ["download", "album", "remove"], more: ["tag", "favorite", "project"] });
    expect(slotsUsed(fit, true)).toBe(PHONE_SLOTS);
  });
  it("with one photo, Rename is the first into More", () => {
    expect(phoneActions(selectionActions({ inAlbum: false, count: 1 }), true)).toEqual({
      shown: ["download", "album", "tag"],
      more: ["favorite", "project", "rename"],
    });
  });
  it("without Trash, the freed slot goes to an action", () => {
    expect(phoneActions(selectionActions({ inAlbum: true, count: 3 }), false)).toEqual({
      shown: ["download", "album", "remove", "tag"],
      more: ["favorite", "project"],
    });
    const fit = phoneActions(selectionActions({ inAlbum: true, count: 1 }), false);
    expect(fit).toEqual({ shown: ["download", "album", "remove", "tag"], more: ["favorite", "project", "rename"] });
    expect(slotsUsed(fit, false)).toBe(PHONE_SLOTS);
  });
});

describe("desktopActions (fit the measured row, never wrap)", () => {
  const widths = { download: 110, album: 125, remove: 165, tag: 70, favorite: 105, project: 115, rename: 100, more: 85 };
  const all = selectionActions({ inAlbum: true, count: 1 });
  const total = 110 + 125 + 165 + 70 + 105 + 115 + 100 + 4 * 6;

  it("shows everything in one row when there is room", () => {
    expect(desktopActions(all, widths, total)).toEqual({ shown: all, more: [] });
  });
  it("folds the least used into More, one at a time, keeping the order", () => {
    expect(desktopActions(all, widths, total - 1)).toEqual({
      shown: ["download", "album", "remove", "tag", "favorite", "project"],
      more: ["rename"],
    });
    expect(desktopActions(all, widths, 110 + 125 + 165 + 85 + 4 * 3)).toEqual({
      shown: ["download", "album", "remove"],
      more: ["tag", "favorite", "project", "rename"],
    });
  });
  it("puts everything behind More when even one action does not fit", () => {
    expect(desktopActions(all, widths, 100)).toEqual({ shown: [], more: all });
  });
});

describe("fitActions", () => {
  it("folds only keys present, in fold order, and returns both lists in display order", () => {
    const fit = fitActions(["a", "b", "c"], ["z", "b", "a", "c"], (shown, more) => shown.length + (more ? 1 : 0) <= 2);
    expect(fit).toEqual({ shown: ["c"], more: ["a", "b"] });
  });
});
