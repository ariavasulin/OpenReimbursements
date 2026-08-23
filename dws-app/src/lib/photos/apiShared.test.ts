import { describe, expect, it } from "vitest";
import { deletionPaths, escapeForIlike, escapeIlikeWildcards } from "./apiShared";

// DELETE /api/photos/:id passes this straight to storage.remove.
describe("deletionPaths", () => {
  it("returns all five paths when present", () => {
    const paths = deletionPaths({
      original_path: "originals/u/p/a.jpg",
      thumb_path: "derived/u/p_thumb.webp",
      preview_path: "derived/u/p_preview.webp",
      sidecar_path: "originals/u/p/a.xmp",
      playback_path: "derived/u/p_playback.mp4",
    });
    expect(paths).toHaveLength(5);
    expect(new Set(paths)).toEqual(
      new Set([
        "originals/u/p/a.jpg",
        "derived/u/p_thumb.webp",
        "derived/u/p_preview.webp",
        "originals/u/p/a.xmp",
        "derived/u/p_playback.mp4",
      ])
    );
  });

  it("drops null and undefined paths", () => {
    expect(
      deletionPaths({
        original_path: "originals/u/p/a.jpg",
        thumb_path: null,
        preview_path: null,
        sidecar_path: null,
      })
    ).toEqual(["originals/u/p/a.jpg"]);
  });
});

describe("ILIKE escaping", () => {
  it("escapeIlikeWildcards neutralises %, _ and \\ and keeps punctuation", () => {
    expect(escapeIlikeWildcards("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeIlikeWildcards(" punch (list) ")).toBe("punch (list)");
  });

  it("escapeForIlike additionally strips PostgREST or() grammar", () => {
    expect(escapeForIlike("punch (list)")).toBe("punch  list");
    expect(escapeForIlike("a,b")).toBe("a b");
    expect(escapeForIlike("()")).toBe("");
  });
});
