import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import type { Receipt } from '@/lib/types'

/** One page of GET /api/receipts (keyset-paginated, 50 rows per page). */
export interface ReceiptsPage {
  receipts: Receipt[]
  nextCursor: string | null
}

export const receiptsKeys = {
  all: ['receipts'] as const,
  mine: () => ['receipts', 'mine'] as const,
}

function fetchMyReceiptsPage(cursor: string | null): Promise<ReceiptsPage> {
  const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return fetchJson<ReceiptsPage>(`/api/receipts${search}`, 'Failed to fetch receipts')
}

/**
 * The signed-in employee's own receipts, newest first. Pages accumulate in the
 * react-query cache (5-minute staleTime from the app's QueryProvider), so
 * remounting within that window renders from cache instead of refetching.
 */
export function useMyReceipts({ enabled = true }: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: receiptsKeys.mine(),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchMyReceiptsPage(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
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
export function useResetMyReceipts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.resetQueries({ queryKey: receiptsKeys.mine() })
  }
}
