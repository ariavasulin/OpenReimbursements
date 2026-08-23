import { describe, expect, it } from "vitest";
import { isStorageNotFound } from "./storageErrors";

describe("isStorageNotFound", () => {
  it("matches a numeric statusCode", () => {
    expect(isStorageNotFound({ statusCode: 404, message: "" })).toBe(true);
  });

  it("matches a string statusCode", () => {
    expect(isStorageNotFound({ statusCode: "404", message: "" })).toBe(true);
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
