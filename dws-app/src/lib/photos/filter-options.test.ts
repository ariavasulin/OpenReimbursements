import { describe, expect, it } from "vitest";
import {
  accumulateSeenOptions,
  emptySeenOptions,
  toUploaderOptions,
} from "./filter-options";
import type { PhotoRow } from "./types";

function photo(partial: Partial<PhotoRow> & { id: string }): PhotoRow {
  return {
    job_id: "job-1",
    uploader_id: "u-1",
    kind: "image",
    tags: [],
    captured_at: "2026-03-18T14:05:00Z",
    captured_at_source: "exif",
    original_path: "p/original.jpg",
    original_bytes: null,
    mime_type: "image/jpeg",
    original_name: "original.jpg",
    thumb_path: null,
    preview_path: null,
    duration_secs: null,
    sidecar_path: null,
    sidecar_name: null,
    created_at: "2026-03-18T14:05:00Z",
    uploader: null,
    job: null,
    ...partial,
  };
}

describe("accumulateSeenOptions", () => {
  it("collects uploaders from a page of photos", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
      photo({ id: "b", uploader_id: "u-2", uploader: { full_name: "Bo" } }),
    ]);
    expect(seen.uploaders.get("u-1")).toBe("Ada");
    expect(seen.uploaders.get("u-2")).toBe("Bo");
  });

  it("ignores nameless uploaders", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", uploader: null }),
      photo({ id: "b", uploader: { full_name: null } }),
    ]);
    expect(seen.uploaders.size).toBe(0);
  });

  it("keeps earlier options when a later page adds new ones", () => {
    const first = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    const second = accumulateSeenOptions(first, [
      photo({ id: "b", uploader_id: "u-2", uploader: { full_name: "Bo" } }),
    ]);
    expect([...second.uploaders.keys()].sort()).toEqual(["u-1", "u-2"]);
  });

  it("returns the same object when a page adds nothing new", () => {
    const first = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    const second = accumulateSeenOptions(first, [
      photo({ id: "b", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    expect(second).toBe(first);
  });

  it("does not mutate the previous options", () => {
    const first = emptySeenOptions();
    accumulateSeenOptions(first, [
      photo({ id: "a", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    expect(first.uploaders.size).toBe(0);
  });
});

describe("toUploaderOptions", () => {
  it("sorts by name, not by id or insertion order", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", uploader_id: "u-9", uploader: { full_name: "Zoe" } }),
      photo({ id: "b", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
      photo({ id: "c", uploader_id: "u-5", uploader: { full_name: "Mel" } }),
    ]);
    expect(toUploaderOptions(seen)).toEqual([
      { value: "u-1", label: "Ada" },
      { value: "u-5", label: "Mel" },
      { value: "u-9", label: "Zoe" },
    ]);
  });
});
