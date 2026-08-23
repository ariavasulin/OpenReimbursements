import { describe, expect, it } from "vitest";
import { decodeReceiptCursor, encodeReceiptCursor } from "./receiptCursor";

describe("receipt cursor", () => {
  it("round-trips", () => {
    const encoded = encodeReceiptCursor("2026-08-01", "2026-08-01T12:00:00.000Z");
    expect(decodeReceiptCursor(encoded)).toEqual({
      receiptDate: "2026-08-01",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
  });

  it("rejects a non-date receiptDate", () => {
    const encoded = encodeReceiptCursor("yesterday", "2026-08-01T00:00:00Z");
    expect(decodeReceiptCursor(encoded)).toBeNull();
  });

  it("rejects an injected filter string in receiptDate", () => {
    const hostile = Buffer.from(
      JSON.stringify(["2026-08-01,or(status.eq.Approved)", "2026-08-01T00:00:00Z"])
    ).toString("base64url");
    expect(decodeReceiptCursor(hostile)).toBeNull();
  });

  it("rejects an injected filter string in createdAt", () => {
    const hostile = Buffer.from(
      JSON.stringify(["2026-08-01", "2026-08-01T00:00:00Z,or(status.eq.Approved)"])
    ).toString("base64url");
    expect(decodeReceiptCursor(hostile)).toBeNull();
  });
});

describe("receipt cursor tiebreaker", () => {
  const encode = (date: string, createdAt: string) =>
    Buffer.from(JSON.stringify([date, createdAt])).toString("base64url");

  it("rejects a malformed createdAt", () => {
    expect(decodeReceiptCursor(encode("2026-08-01", "---"))).toBeNull();
    expect(decodeReceiptCursor(encode("2026-08-01", "+"))).toBeNull();
    expect(decodeReceiptCursor(encode("2026-08-01", "2026-13-99T99:99:99Z"))).toBeNull();
  });

  it("rejects an impossible receiptDate", () => {
    expect(decodeReceiptCursor(encode("2026-13-45", "2026-08-01T00:00:00Z"))).toBeNull();
  });
});
