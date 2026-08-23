import { describe, expect, it } from "vitest";
import {
  buildPhotoLink,
  parsePhotoParam,
  withPhotoParam,
  withoutPhotoParam,
} from "./photo-link";

describe("buildPhotoLink", () => {
  it("builds a job-scoped URL", () => {
    expect(buildPhotoLink("https://photos.dws-receipts.com", "job-1", "p-1"))
      .toBe("https://photos.dws-receipts.com/photos/job-1?photo=p-1");
  });
});

describe("parsePhotoParam", () => {
  it("reads the id with or without a leading ?", () => {
    expect(parsePhotoParam("?photo=abc")).toBe("abc");
    expect(parsePhotoParam("photo=abc")).toBe("abc");
  });
  it("is null when absent or blank", () => {
    expect(parsePhotoParam("")).toBeNull();
    expect(parsePhotoParam("?q=hello")).toBeNull();
    expect(parsePhotoParam("?photo=")).toBeNull();
    expect(parsePhotoParam("?photo=%20%20")).toBeNull();
  });
  it("returns the trimmed id, never the padded raw value", () => {
    expect(parsePhotoParam("?photo=%20abc")).toBe("abc");
    expect(parsePhotoParam("?photo=abc%20")).toBe("abc");
    expect(parsePhotoParam("?photo=+abc+")).toBe("abc");
  });
});

describe("withPhotoParam / withoutPhotoParam", () => {
  it("adds, replaces, and preserves other params", () => {
    expect(withPhotoParam("", "p1")).toBe("?photo=p1");
    expect(withPhotoParam("?photo=old", "p2")).toBe("?photo=p2");
    expect(withPhotoParam("?sheet=12", "p1")).toBe("?sheet=12&photo=p1");
  });
  it("removes it and collapses to empty when it was the only param", () => {
    expect(withoutPhotoParam("?photo=p1")).toBe("");
    expect(withoutPhotoParam("?sheet=12&photo=p1")).toBe("?sheet=12");
    expect(withoutPhotoParam("?sheet=12")).toBe("?sheet=12");
  });
});
