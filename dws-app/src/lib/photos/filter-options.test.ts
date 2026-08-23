import { describe, expect, it } from "vitest";
import {
  accumulateSeenOptions,
  emptySeenOptions,
  toSheetOptions,
  toUploaderOptions,
} from "./filter-options";
import type { PhotoRow } from "./types";

function photo(partial: Partial<PhotoRow> & { id: string }): PhotoRow {
  return {
    job_id: "job-1",
    uploader_id: "u-1",
    kind: "image",
    sheet_number: null,
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
  it("collects sheets and uploaders from a page of photos", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "12", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
      photo({ id: "b", sheet_number: " 7 ", uploader_id: "u-2", uploader: { full_name: "Bo" } }),
    ]);
    expect([...seen.sheets]).toEqual(["12", "7"]);
    expect([...seen.uploaders]).toEqual([
      ["u-1", "Ada"],
      ["u-2", "Bo"],
    ]);
  });

  it("ignores blank sheets and nameless uploaders", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "   ", uploader: null }),
      photo({ id: "b", sheet_number: null, uploader: { full_name: null } }),
    ]);
    expect(seen.sheets.size).toBe(0);
    expect(seen.uploaders.size).toBe(0);
  });

  it("keeps earlier options when a later page adds new ones", () => {
    const first = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "12", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    const second = accumulateSeenOptions(first, [
      photo({ id: "b", sheet_number: "3", uploader_id: "u-2", uploader: { full_name: "Bo" } }),
    ]);
    expect([...second.sheets].sort()).toEqual(["12", "3"]);
    expect([...second.uploaders.keys()].sort()).toEqual(["u-1", "u-2"]);
  });

  it("returns the same object when a page adds nothing new", () => {
    const first = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "12", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    const second = accumulateSeenOptions(first, [
      photo({ id: "b", sheet_number: "12", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    expect(second).toBe(first);
  });

  it("does not mutate the previous options", () => {
    const first = emptySeenOptions();
    accumulateSeenOptions(first, [
      photo({ id: "a", sheet_number: "12", uploader_id: "u-1", uploader: { full_name: "Ada" } }),
    ]);
    expect(first.sheets.size).toBe(0);
    expect(first.uploaders.size).toBe(0);
  });
});

describe("toSheetOptions", () => {
  it("sorts numerically descending", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "2" }),
      photo({ id: "b", sheet_number: "10" }),
      photo({ id: "c", sheet_number: "9" }),
    ]);
    expect(toSheetOptions(seen)).toEqual([
      { value: "10", label: "Sheet 10" },
      { value: "9", label: "Sheet 9" },
      { value: "2", label: "Sheet 2" },
    ]);
  });

  it("orders a mixed set the same way whatever order it arrived in", () => {
    // Sheet is free text, so "2A" can sit next to "3" — and the Set is
    // accumulated across pages, so insertion order is pagination order.
    const arrivals = [
      ["2", "3", "2A"],
      ["3", "2", "2A"],
      ["2A", "2", "3"],
    ];
    for (const sheets of arrivals) {
      const seen = accumulateSeenOptions(
        emptySeenOptions(),
        sheets.map((sheet, index) => photo({ id: `p${index}`, sheet_number: sheet }))
      );
      expect(toSheetOptions(seen).map((option) => option.value)).toEqual([
        "3",
        "2",
        "2A",
      ]);
    }
  });

  it("falls back to alphabetical for non-numeric sheets", () => {
    const seen = accumulateSeenOptions(emptySeenOptions(), [
      photo({ id: "a", sheet_number: "B-2" }),
      photo({ id: "b", sheet_number: "A-1" }),
    ]);
    expect(toSheetOptions(seen).map((option) => option.value)).toEqual([
      "A-1",
      "B-2",
    ]);
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
