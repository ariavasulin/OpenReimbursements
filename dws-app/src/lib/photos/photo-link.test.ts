import { describe, expect, it } from "vitest";
import {
  buildPhotoLink,
  parsePhotoParam,
  photoPath,
  withPhotoParam,
  withoutPhotoParam,
} from "./photo-link";

// photo-albums AC-11: "Copy link" names the photo only, on whichever address the app is open.
describe("buildPhotoLink", () => {
  it("writes /photos?photo=<id> with no project in the path, on the new and the old address", () => {
    expect(buildPhotoLink("https://photos.design-workshops.app", "p-1"))
      .toBe("https://photos.design-workshops.app/photos?photo=p-1");
    expect(buildPhotoLink("https://photos.dws-receipts.com", "p-1"))
      .toBe("https://photos.dws-receipts.com/photos?photo=p-1");
  });
  it("round-trips through parsePhotoParam and escapes the id", () => {
    const link = new URL(buildPhotoLink("https://photos.design-workshops.app", "a b&c"));
    expect(link.pathname).toBe("/photos");
    expect(parsePhotoParam(link.search)).toBe("a b&c");
  });
});

describe("photoPath", () => {
  it("keeps the project page for a photo with a project", () => {
    expect(photoPath("job-1", "p-1")).toBe("/photos/job-1?photo=p-1");
  });
  it("opens a photo with no project from Photos, never from /photos/null", () => {
    expect(photoPath(null, "p-1")).toBe("/photos?photo=p-1");
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
    expect(withPhotoParam("?q=roof", "p1")).toBe("?q=roof&photo=p1");
  });
  it("removes it and collapses to empty when it was the only param", () => {
    expect(withoutPhotoParam("?photo=p1")).toBe("");
    expect(withoutPhotoParam("?q=roof&photo=p1")).toBe("?q=roof");
    expect(withoutPhotoParam("?q=roof")).toBe("?q=roof");
  });
});
