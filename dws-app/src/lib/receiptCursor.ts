import { decodeKeysetCursor, isIsoTimestamp } from "./keysetCursor";

// Keyset-pagination cursor for GET /api/receipts, keyed on
// (receipt_date, created_at).
export type ReceiptCursor = { receiptDate: string; createdAt: string };

export function decodeReceiptCursor(raw: string): ReceiptCursor | null {
  return decodeKeysetCursor(raw, (receiptDate, createdAt) => {
    // Reject anything that isn't a real date / timestamp before it reaches a
    // PostgREST filter string.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate) || Number.isNaN(Date.parse(receiptDate))) return null;
    if (!isIsoTimestamp(createdAt)) return null;
    return { receiptDate, createdAt };
  });
}
