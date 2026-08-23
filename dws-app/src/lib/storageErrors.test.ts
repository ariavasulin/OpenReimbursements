import { describe, expect, it } from "vitest";
import { isStorageNotFound } from "./storageErrors";

describe("isStorageNotFound", () => {
  it("matches a numeric statusCode", () => {
    expect(isStorageNotFound({ statusCode: 404, message: "" })).toBe(true);
  });

  it("matches a string statusCode", () => {
    expect(isStorageNotFound({ statusCode: "404", message: "" })).toBe(true);
  });

  it("matches the shape the pinned storage client produces: status + message", () => {
    expect(isStorageNotFound({ status: 404, message: "Object not found" })).toBe(true);
    expect(isStorageNotFound({ status: "404", message: "Object not found" })).toBe(true);
  });

  it("lets a present status decide, even when the message says not found", () => {
    expect(isStorageNotFound({ status: 500, message: "bucket not found in region" })).toBe(false);
    expect(isStorageNotFound({ statusCode: 503, message: "Object not found" })).toBe(false);
  });

  it("matches the message when no status is present", () => {
    expect(isStorageNotFound({ message: "Object not found" })).toBe(true);
  });

  it("matches the error field", () => {
    expect(isStorageNotFound({ error: "not_found", message: "Object not found" })).toBe(true);
  });

  it("rejects other storage failures", () => {
    expect(isStorageNotFound({ statusCode: 500, message: "Internal error" })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isStorageNotFound(null)).toBe(false);
    expect(isStorageNotFound("404")).toBe(false);
  });
});
