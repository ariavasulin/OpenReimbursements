// Keyset-pagination cursor for GET /api/receipts, keyed on
// (receipt_date, created_at). Mirrors the encodeCursor/decodeCursor pair in
// src/app/api/photos/route.ts so the codebase has one pagination idiom.
export type ReceiptCursor = { receiptDate: string; createdAt: string };

export function encodeReceiptCursor(receiptDate: string, createdAt: string): string {
  return Buffer.from(JSON.stringify([receiptDate, createdAt])).toString("base64url");
}

export function decodeReceiptCursor(raw: string): ReceiptCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [receiptDate, createdAt] = parsed;
    if (typeof receiptDate !== "string" || typeof createdAt !== "string") return null;
    // Reject anything that isn't a plain date / timestamp before it reaches a
    // PostgREST filter string.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) return null;
    if (!/^[\d\-:.TZ+ ]+$/.test(createdAt)) return null;
    return { receiptDate, createdAt };
  } catch {
    return null;
  }
}
