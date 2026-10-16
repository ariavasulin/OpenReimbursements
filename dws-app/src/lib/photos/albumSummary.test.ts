import { describe, expect, it } from "vitest";
import { mapAlbumSummary } from "./albumSummary";
import { albumHeaderFromSummary } from "./api";
import type { PhotoAlbumSummaryRow } from "./types";

describe("mapAlbumSummary", () => {
  const row = {
    id: "a1", name: "Christmas Party", photo_count: "42",
    latest_added: "2026-09-01T00:00:00Z", thumbs: null, created_at: "2026-08-01T00:00:00Z",
    created_by: null, sort_mode: "date" as const, has_custom_order: false,
  };
  it("coerces the bigint count, defaults null thumbs, and carries the latest-added time for the Sort chip", () => {
    expect(mapAlbumSummary(row)).toEqual({
      id: "a1", name: "Christmas Party", photo_count: 42, thumb_paths: [], created_at: "2026-08-01T00:00:00Z",
      created_by: null, latest_activity: "2026-09-01T00:00:00Z", sort_mode: "date", has_custom_order: false,
    });
    expect(mapAlbumSummary({ ...row, created_by: "u1" }).created_by).toBe("u1");
    expect(mapAlbumSummary({ ...row, thumbs: ["a.webp"] }).thumb_paths).toEqual(["a.webp"]);
  });
  it("carries the album's order, so its page can start loading photos without the header", () => {
    expect(mapAlbumSummary({ ...row, sort_mode: "custom", has_custom_order: true }))
      .toMatchObject({ sort_mode: "custom", has_custom_order: true });
    expect(mapAlbumSummary({ ...row, has_custom_order: true })).toMatchObject({ sort_mode: "date", has_custom_order: true });
  });
  it("leaves the order out when an older database row lacks it, so the page does not guess it", () => {
    const older: PhotoAlbumSummaryRow = { ...row };
    delete older.sort_mode;
    delete older.has_custom_order;
    const card = mapAlbumSummary(older);
    expect(card).not.toHaveProperty("sort_mode");
    expect(card).not.toHaveProperty("has_custom_order");
    expect(albumHeaderFromSummary(card)).toBeUndefined();
  });
});
