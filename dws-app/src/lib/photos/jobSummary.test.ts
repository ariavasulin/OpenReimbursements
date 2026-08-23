import { describe, expect, it } from "vitest";
import { mapJobSummary } from "./jobSummary";

describe("mapJobSummary", () => {
  it("coerces a bigint count arriving as a string", () => {
    const row = {
      id: "j1", job_number: "3612", name: "Site A", location: null,
      photo_count: "42", latest_upload: "2026-08-01T00:00:00Z", thumbs: ["a.webp"],
    };
    expect(mapJobSummary(row).photo_count).toBe(42);
  });

  it("defaults a null thumbs array to empty", () => {
    const row = {
      id: "j2", job_number: "3613", name: "Site B", location: null,
      photo_count: 0, latest_upload: null, thumbs: null,
    };
    expect(mapJobSummary(row).thumb_paths).toEqual([]);
    expect(mapJobSummary({ ...row, thumbs: ["a.webp", "b.webp"] }).thumb_paths).toEqual(["a.webp", "b.webp"]);
  });

  it("does not leak latest_upload into the wire shape", () => {
    const row = {
      id: "j4", job_number: "3615", name: "Site D", location: null,
      photo_count: 1, latest_upload: "2026-08-03T00:00:00Z", thumbs: [],
    };
    expect(mapJobSummary(row)).not.toHaveProperty("latest_upload");
  });
});
