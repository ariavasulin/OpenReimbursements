/**
 * The admin dashboard's free-text receipt search.
 *
 * The table's copy runs in SQL: get_admin_receipts_page applies the same
 * match (case-insensitive substring over the employee's display name and the
 * description) inside its filtered CTE, so the page, the totals and the pager
 * agree. This module is the JS twin for the payroll CSV export, which still
 * reads the full set through get_admin_receipts_with_phone and filters here —
 * as the pre-pagination dashboard did over its client-side rows. Keep the two
 * matchers in step.
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
