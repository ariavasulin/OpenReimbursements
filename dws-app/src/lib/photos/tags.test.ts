import { describe, expect, it } from "vitest";
import {
  addTagToMeta, appendResolvedTag, appendTag, resolveTag, STARTER_TAGS, tagChoices, tagMenu,
  tagSuggestions, toTagPairs, type PhotoMeta,
} from "./tags";

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
    albums: [],
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

describe("the tag dropdown", () => {
  const choices = tagChoices(["Roof", "kitchen", "Professional"]);

  it("always offers the three starter tags, even when no photo carries one", () => {
    expect(tagChoices([])).toEqual(["field dimension", "professional", "shop drawing"]);
    expect([...STARTER_TAGS]).toEqual(["professional", "field dimension", "shop drawing"]);
  });

  it("lists existing and starter tags once each, A to Z ignoring case; an existing spelling wins", () => {
    expect(choices).toEqual(["field dimension", "kitchen", "Professional", "Roof", "shop drawing"]);
  });

  it("opens to every choice that is not already picked", () => {
    expect(tagMenu(choices, ["Roof"], "")).toEqual({
      options: ["field dimension", "kitchen", "Professional", "shop drawing"], add: null,
    });
  });

  it("narrows as you type, ignoring case, and ends with Add for text that is new", () => {
    expect(tagMenu(choices, [], "KIT")).toEqual({ options: ["kitchen"], add: "KIT" });
    expect(tagMenu(choices, [], "  punch list ")).toEqual({ options: [], add: "punch list" });
  });

  it("offers no Add row for text that matches a choice ignoring case, or that is already picked", () => {
    expect(tagMenu(choices, [], "Kitchen")).toEqual({ options: ["kitchen"], add: null });
    expect(tagMenu(choices, ["kitchen"], "KITCHEN")).toEqual({ options: [], add: null });
    expect(tagMenu(choices, ["punch list"], "Punch List")).toEqual({ options: [], add: null });
  });

  it("stores the existing or starter spelling for what was typed", () => {
    expect(resolveTag(" Kitchen ", choices)).toBe("kitchen");
    // A starter tag matches before any photo carries it.
    expect(resolveTag("Shop Drawing", tagChoices([]))).toBe("shop drawing");
    expect(resolveTag("Professional", tagChoices([]))).toBe("professional");
    expect(resolveTag("  brand new ", choices)).toBe("brand new");
  });

  it("appends the resolved spelling once", () => {
    expect(appendResolvedTag(["Roof"], "KITCHEN", choices)).toEqual(["Roof", "kitchen"]);
    const same = ["kitchen"];
    expect(appendResolvedTag(same, "Kitchen", choices)).toBe(same);
    expect(appendResolvedTag(same, "   ", choices)).toBe(same);
  });
});
