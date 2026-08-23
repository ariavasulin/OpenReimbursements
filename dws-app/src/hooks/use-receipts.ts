import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import type { Receipt, ReceiptStatusValue } from '@/lib/types'

/** One page of GET /api/receipts (keyset-paginated, 50 rows per page). */
export interface ReceiptsPage {
  receipts: Receipt[]
  nextCursor: string | null
}

/** Status values the employee filter can send; 'all' means no filter. */
export type ReceiptStatusFilter = 'all' | Lowercase<ReceiptStatusValue>

/**
 * Cache keys for the employee's own receipts. Keyed by user id and status:
 * statuses are separate server-side result sets, and cache entries must not
 * cross accounts.
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
 * and fetches once.
 */
export function useResetMyReceipts(userId: string | null | undefined) {
  const queryClient = useQueryClient()

  return () => {
    queryClient.resetQueries({ queryKey: receiptsKeys.mineForUser(userId) })
  }
}
