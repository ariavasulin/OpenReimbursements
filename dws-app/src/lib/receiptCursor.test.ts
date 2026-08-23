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

  it("rejects malformed base64", () => {
    expect(decodeReceiptCursor("!!!not-base64!!!")).toBeNull();
  });

  it("rejects plain garbage", () => {
    expect(decodeReceiptCursor("garbage")).toBeNull();
  });

  it("rejects a wrong-shaped payload", () => {
    expect(decodeReceiptCursor(Buffer.from('["a"]').toString("base64url"))).toBeNull();
    expect(
      decodeReceiptCursor(Buffer.from('{"receiptDate":"2026-08-01"}').toString("base64url"))
    ).toBeNull();
    expect(
      decodeReceiptCursor(Buffer.from('[1, 2]').toString("base64url"))
    ).toBeNull();
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
