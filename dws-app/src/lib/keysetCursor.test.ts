import { describe, expect, it } from "vitest";
import { decodeKeysetCursor, encodeKeysetCursor, isIsoTimestamp, keysetOrFilter } from "./keysetCursor";

const pass = (first: string, second: string) => ({ first, second });

describe("keyset cursor", () => {
  it("round-trips a pair of strings", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("a", "b"), pass)).toEqual({
      first: "a",
      second: "b",
    });
  });

  it("survives values that need JSON escaping", () => {
    const weird = '"quotes", commas, \\backslash';
    expect(decodeKeysetCursor(encodeKeysetCursor(weird, "b"), pass)).toEqual({
      first: weird,
      second: "b",
    });
  });

  it("emits base64url, not base64 (no +, /, or = to mangle in a query string)", () => {
    // These bytes encode to "...w73DvCIsIsO7..." in plain base64 — the '+' and
    // '=' only disappear because the codec asks for base64url.
    const encoded = encodeKeysetCursor("\u00ff\u00fe\u00fd\u00fc", "\u00fb\u00fa");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeysetCursor(encoded, pass)).toEqual({
      first: "\u00ff\u00fe\u00fd\u00fc",
      second: "\u00fb\u00fa",
    });
  });

  it("returns null for malformed base64 rather than throwing", () => {
    expect(decodeKeysetCursor("!!!not-base64!!!", pass)).toBeNull();
    expect(decodeKeysetCursor("garbage", pass)).toBeNull();
    expect(decodeKeysetCursor("", pass)).toBeNull();
  });

  it("rejects payloads that are not a two-string tuple", () => {
    const encode = (json: string) => Buffer.from(json).toString("base64url");
    expect(decodeKeysetCursor(encode('["a"]'), pass)).toBeNull();
    expect(decodeKeysetCursor(encode('["a","b","c"]'), pass)).toBeNull();
    expect(decodeKeysetCursor(encode("[1,2]"), pass)).toBeNull();
    expect(decodeKeysetCursor(encode('["a",null]'), pass)).toBeNull();
    expect(decodeKeysetCursor(encode('{"first":"a","second":"b"}'), pass)).toBeNull();
    expect(decodeKeysetCursor(encode('"a"'), pass)).toBeNull();
  });

  it("returns null when the validator rejects", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("a", "b"), () => null)).toBeNull();
  });

  it("returns whatever shape the validator builds", () => {
    const decoded = decodeKeysetCursor(encodeKeysetCursor("2026-08-01", "id-1"), (date, id) => ({
      capturedAt: date,
      id,
    }));
    expect(decoded).toEqual({ capturedAt: "2026-08-01", id: "id-1" });
  });

  it("returns null when the validator throws", () => {
    expect(
      decodeKeysetCursor(encodeKeysetCursor("a", "b"), () => {
        throw new Error("boom");
      })
    ).toBeNull();
  });
});

describe("isIsoTimestamp", () => {
  it("accepts the shapes PostgREST emits", () => {
    expect(isIsoTimestamp("2026-08-01T12:00:00Z")).toBe(true);
    expect(isIsoTimestamp("2026-08-01T12:00:00.123456+00:00")).toBe(true);
    expect(isIsoTimestamp("2026-08-01 12:00:00-07")).toBe(true);
  });

  it("rejects malformed timestamps", () => {
    expect(isIsoTimestamp("---")).toBe(false);
    expect(isIsoTimestamp("+")).toBe(false);
    expect(isIsoTimestamp("2026-13-99T99:99:99Z")).toBe(false);
    expect(isIsoTimestamp("2026-08-01")).toBe(false);
    expect(isIsoTimestamp("2026-08-01T12:00:00Z,or(status.eq.Approved)")).toBe(false);
  });
});

describe("keysetOrFilter", () => {
  it("builds 'strictly past this position' for a descending sort", () => {
    expect(
      keysetOrFilter("receipt_date", "2026-08-01", "created_at", "2026-08-01T12:00:00Z")
    ).toBe(
      "receipt_date.lt.2026-08-01,and(receipt_date.eq.2026-08-01,created_at.lt.2026-08-01T12:00:00Z)"
    );
  });
});
