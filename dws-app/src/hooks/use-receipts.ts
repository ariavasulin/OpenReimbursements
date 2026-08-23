import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import type { Receipt } from '@/lib/types'

/** One page of GET /api/receipts (keyset-paginated, 50 rows per page). */
export interface ReceiptsPage {
  receipts: Receipt[]
  nextCursor: string | null
}

/** Status values the employee filter can send; 'all' means no filter. */
export type ReceiptStatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'reimbursed'

/**
 * Cache keys for the employee's own receipts.
 *
 * The user id is part of the key on purpose. With a constant key, two accounts
 * signing in on the same device within the 5-minute staleTime shared one cache
 * entry, so the second employee could be served the first one's receipts with
 * no request. The status is part of the key because filtering happens
 * server-side (see GET /api/receipts): each status is a different result set.
 */
export const receiptsKeys = {
  all: ['receipts'] as const,
  mine: (userId: string | null | undefined, status: ReceiptStatusFilter = 'all') =>
    ['receipts', 'mine', userId ?? null, status] as const,
  /** Every status for one user — the right scope for a post-mutation reset. */
  mineForUser: (userId: string | null | undefined) =>
    ['receipts', 'mine', userId ?? null] as const,
}

function fetchMyReceiptsPage(
  cursor: string | null,
  status: ReceiptStatusFilter
): Promise<ReceiptsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (status !== 'all') params.set('status', status)
  const search = params.toString()
  return fetchJson<ReceiptsPage>(
    `/api/receipts${search ? `?${search}` : ''}`,
    'Failed to fetch receipts'
  )
}

/**
 * The signed-in employee's own receipts, newest first, optionally narrowed to
 * one status. Pages accumulate in the react-query cache (5-minute staleTime
 * from the app's QueryProvider), so remounting within that window renders from
 * cache instead of refetching.
 *
 * The status filter is a server-side query parameter rather than a filter over
 * the loaded rows: only the first page is loaded up front, so filtering
 * client-side searched a 50-row prefix and reported "No receipts found" for
 * employees whose matching receipt sat further back in their history.
 */
export function useMyReceipts({
  userId,
  status = 'all',
  enabled = true,
}: {
  userId: string | null | undefined
  status?: ReceiptStatusFilter
  enabled?: boolean
}) {
  return useInfiniteQuery({
    queryKey: receiptsKeys.mine(userId, status),
    enabled: enabled && Boolean(userId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchMyReceiptsPage(pageParam, status),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Switching the status filter swaps the key; without this the table would
    // unmount into a loading state (taking the filter dropdown with it).
    placeholderData: keepPreviousData,
  })
}

/**
 * Post-mutation refresh after adding or editing a receipt.
 *
 * Deliberately reset, not invalidate: this is an infinite query, and
 * invalidateQueries refetches every cached page — sequentially, because keyset
 * pages can only be fetched in cursor order. resetQueries drops back to page 1
 * and fetches once, which is also the right view after a change (the new or
 * edited receipt is newest, so it belongs on page 1).
 */
export function useResetMyReceipts(userId: string | null | undefined) {
  const queryClient = useQueryClient()

  return () => {
    queryClient.resetQueries({ queryKey: receiptsKeys.mineForUser(userId) })
  }
}
