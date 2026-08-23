import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import type { Receipt, ReceiptStatusFilter } from '@/lib/types'

/** One page of GET /api/receipts (keyset-paginated). */
export interface ReceiptsPage {
  receipts: Receipt[]
  nextCursor: string | null
}

/** Cache entries must not cross accounts, and statuses are separate result sets. */
export const receiptsKeys = {
  mine: (userId: string | null | undefined, status: ReceiptStatusFilter) =>
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

/** The signed-in employee's own receipts, newest first, optionally narrowed to one status. */
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

/** afterEdit refetches loaded pages so the user keeps their place; afterUpload drops back to page 1. */
export function useRefreshMyReceipts(userId: string | null | undefined) {
  const queryClient = useQueryClient()
  const queryKey = receiptsKeys.mineForUser(userId)

  return {
    afterUpload: () => queryClient.resetQueries({ queryKey }),
    afterEdit: () => queryClient.invalidateQueries({ queryKey }),
  }
}
