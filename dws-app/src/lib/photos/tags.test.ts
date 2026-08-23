import { describe, expect, it } from "vitest";
import { addTagToMeta, appendTag, tagSuggestions, toTagPairs, type PhotoMeta } from "./tags";

const known = toTagPairs(["Roof", "rough-in", "Drywall", "roofing", "Plumbing"]);

describe("tagSuggestions", () => {
  it("returns nothing for blank input", () => {
    expect(tagSuggestions(known, "", [])).toEqual([]);
    expect(tagSuggestions(known, "   ", [])).toEqual([]);
  });

  it("matches case-insensitively and keeps the original casing", () => {
    expect(tagSuggestions(known, "ROO", [])).toEqual(["Roof", "roofing"]);
  });

  it("excludes tags already chosen", () => {
    expect(tagSuggestions(known, "roo", ["Roof"])).toEqual(["roofing"]);
  });

  it("caps the result at the limit", () => {
    const many = toTagPairs(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    expect(tagSuggestions(many, "a", [])).toHaveLength(6);
    expect(tagSuggestions(many, "a", [], 2)).toEqual(["a1", "a2"]);
  });

  it("matches against the pre-lowercased form", () => {
    expect(tagSuggestions(known, "dry", [])).toEqual(["Drywall"]);
  });
});

describe("appendTag", () => {
  it("trims and appends a new tag", () => {
    expect(appendTag(["a"], "  b ")).toEqual(["a", "b"]);
  });

  it("returns the same array for blank or duplicate input", () => {
    const tags = ["a"];
    expect(appendTag(tags, "  ")).toBe(tags);
    expect(appendTag(tags, "a")).toBe(tags);
  });
});

describe("addTagToMeta", () => {
  const meta: PhotoMeta = {
    jobId: "j1",
    sheetNumber: "3",
    tags: ["Roof"],
    tagInput: "dry",
  };

  it("adds the tag and clears the input in one transition", () => {
    const next = addTagToMeta(meta, "Drywall");
    expect(next).toEqual({ ...meta, tags: ["Roof", "Drywall"], tagInput: "" });
  });

  it("still clears the input when the tag is a duplicate", () => {
    expect(addTagToMeta(meta, "Roof")).toEqual({ ...meta, tagInput: "" });
  });
});
