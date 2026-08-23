/**
 * The admin dashboard's free-text receipt search.
 *
 * Shared so the payroll CSV export applies exactly the filter the table shows.
 * The export used to read only status and dates, so an admin who searched for
 * one employee and clicked Export got a CSV covering everyone.
 *
 * Case-insensitive substring match over the employee name and the receipt
 * description — the same two fields the table has always searched.
 */
export interface ReceiptSearchFields {
  employeeName?: string | null
  description?: string | null
}

/** Trimmed, lowercased search term; '' means "no search". */
export function normalizeReceiptSearch(query: string | null | undefined): string {
  return (query ?? '').trim().toLowerCase()
}

/** `normalized` must come from normalizeReceiptSearch; '' matches everything. */
export function receiptMatchesSearch(
  receipt: ReceiptSearchFields,
  normalized: string
): boolean {
  if (!normalized) return true
  const employeeName = receipt.employeeName?.toLowerCase() ?? ''
  const description = receipt.description?.toLowerCase() ?? ''
  return employeeName.includes(normalized) || description.includes(normalized)
}
