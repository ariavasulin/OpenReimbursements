import { describe, expect, it } from "vitest";
import { encodeKeysetCursor } from "./keysetCursor";
import { decodeReceiptCursor } from "./receiptCursor";

describe("receipt cursor", () => {
  it("round-trips", () => {
    const encoded = encodeKeysetCursor("2026-08-01", "2026-08-01T12:00:00.000Z");
    expect(decodeReceiptCursor(encoded)).toEqual({
      receiptDate: "2026-08-01",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
  });

  it("rejects a non-date receiptDate", () => {
    expect(decodeReceiptCursor(encodeKeysetCursor("yesterday", "2026-08-01T00:00:00Z"))).toBeNull();
    expect(decodeReceiptCursor(encodeKeysetCursor("2026-13-45", "2026-08-01T00:00:00Z"))).toBeNull();
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
