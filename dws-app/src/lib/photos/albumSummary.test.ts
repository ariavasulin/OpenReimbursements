import { describe, expect, it } from "vitest";
import { mapAlbumSummary } from "./albumSummary";

describe("mapAlbumSummary", () => {
  const row = {
    id: "a1", name: "Christmas Party", photo_count: "42",
    latest_added: "2026-09-01T00:00:00Z", thumbs: null, created_at: "2026-08-01T00:00:00Z",
  };
  it("coerces the bigint count, defaults null thumbs, and keeps the ordering column off the wire", () => {
    expect(mapAlbumSummary(row)).toEqual({
      id: "a1", name: "Christmas Party", photo_count: 42, thumb_paths: [], created_at: "2026-08-01T00:00:00Z",
    });
    expect(mapAlbumSummary({ ...row, thumbs: ["a.webp"] }).thumb_paths).toEqual(["a.webp"]);
  });
});
