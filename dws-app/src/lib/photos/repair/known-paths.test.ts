import { describe, expect, it } from "vitest";
import {
  PATH_COLUMNS,
  knownPaths,
  markOwnership,
  type ListedObject,
  type PathRow,
} from "./known-paths";

/** A row that owns one object per path column. */
const row = (over: Partial<PathRow> = {}): PathRow => ({
  original_path: "originals/u1/p1/a.jpg",
  sidecar_path: "originals/u1/p1/a.aae",
  thumb_path: "derived/u1/p1_thumb.webp",
  preview_path: "derived/u1/p1_preview.webp",
  playback_path: "derived/u1/p1_playback.mp4",
  ...over,
});

const object = (name: string): ListedObject => ({
  name,
  created_at: new Date(0).toISOString(),
});

/** The names markOwnership left unowned — what the sweep may delete. */
const candidates = (objects: ListedObject[], known: Set<string>) =>
  markOwnership(objects, known)
    .filter((o) => !o.has_row)
    .map((o) => o.name);

describe("knownPaths", () => {
  it("skips null columns", () => {
    const known = knownPaths([row({ sidecar_path: null, playback_path: null })]);
    expect(known.size).toBe(3);
  });
});

describe("markOwnership", () => {
  it("makes a derived object with no owning row a candidate", () => {
    const orphan = object("derived/u1/gone_thumb.webp");
    expect(candidates([orphan], knownPaths([row()]))).toEqual([orphan.name]);
  });

  it("spares an object owned by any one of the five path columns", () => {
    const known = knownPaths([row()]);
    for (const column of PATH_COLUMNS) {
      const owned = row()[column]!;
      expect(candidates([object(owned)], known)).toEqual([]);
    }
  });
});
