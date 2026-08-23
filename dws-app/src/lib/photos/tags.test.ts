import { describe, expect, it } from "vitest";
import { tagSuggestions, toTagPairs } from "./tags";

const known = ["Roof", "rough-in", "Drywall", "roofing", "Plumbing"];

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
    const many = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    expect(tagSuggestions(many, "a", [])).toHaveLength(6);
    expect(tagSuggestions(many, "a", [], 2)).toEqual(["a1", "a2"]);
  });

  it("accepts pre-lowercased pairs", () => {
    expect(tagSuggestions(toTagPairs(known), "dry", [])).toEqual(["Drywall"]);
  });
});
