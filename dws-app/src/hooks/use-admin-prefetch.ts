import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { pendingReceiptsKeys, fetchPendingReceipts } from './use-pending-receipts'
import { adminUsersKeys, fetchAdminUsers } from './use-admin-users'

export function useAdminPrefetch() {
  const queryClient = useQueryClient()
  const prefetchedRef = useRef(false)

  useEffect(() => {
    if (prefetchedRef.current) return
    prefetchedRef.current = true

    const timeoutId = setTimeout(() => {
      queryClient.prefetchQuery({
        queryKey: pendingReceiptsKeys.list(),
        queryFn: fetchPendingReceipts,
      })

      queryClient.prefetchQuery({
        queryKey: adminUsersKeys.list(),
        queryFn: fetchAdminUsers,
      })
    }, 500) // 500ms delay

    return () => clearTimeout(timeoutId)
  }, [queryClient])
}
