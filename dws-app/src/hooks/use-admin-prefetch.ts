import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { pendingReceiptsKeys, fetchPendingReceipts } from './use-pending-receipts'
import { adminUsersKeys, fetchAdminUsers } from './use-admin-users'

/**
 * Prefetches batch review (pending receipts) and user management data
 * in the background after a short delay to prioritize main content loading.
 *
 * Uses React Query's prefetchQuery to populate the cache so that when
 * users navigate to /batch-review or /users, the data is already loaded.
 */
export function useAdminPrefetch() {
  const queryClient = useQueryClient()
  const prefetchedRef = useRef(false)

  useEffect(() => {
    // Only prefetch once per session
    if (prefetchedRef.current) return
    prefetchedRef.current = true

    // Delay prefetch to let main dashboard content load first
    const timeoutId = setTimeout(() => {
      // Prefetch pending receipts for batch review page
      queryClient.prefetchQuery({
        queryKey: pendingReceiptsKeys.list(),
        queryFn: fetchPendingReceipts,
      })

      // Prefetch admin users for user management page
      queryClient.prefetchQuery({
        queryKey: adminUsersKeys.list(),
        queryFn: fetchAdminUsers,
      })
    }, 500) // 500ms delay

    return () => clearTimeout(timeoutId)
  }, [queryClient])
}
