import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Receipt } from '@/lib/types'

// Types for query parameters
interface AdminReceiptsParams {
  status?: string
  fromDate?: string
  toDate?: string
  enabled?: boolean
}

// Query key factory for consistent cache keys
export const adminReceiptsKeys = {
  all: ['admin-receipts'] as const,
  list: (params: AdminReceiptsParams) => ['admin-receipts', params] as const,
}

// Fetch function
async function fetchAdminReceipts(params: AdminReceiptsParams): Promise<Receipt[]> {
  const urlParams = new URLSearchParams()

  if (params.status && params.status !== 'all') {
    const dbStatus = params.status.charAt(0).toUpperCase() + params.status.slice(1)
    urlParams.append('status', dbStatus)
  }

  if (params.fromDate) {
    urlParams.append('fromDate', params.fromDate)
  }

  if (params.toDate) {
    urlParams.append('toDate', params.toDate)
  }

  const response = await fetch(`/api/admin/receipts?${urlParams.toString()}`)

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || `Failed to fetch receipts: ${response.status}`)
  }

  const data = await response.json()

  if (!data.success) {
    throw new Error(data.error || 'Failed to fetch receipts')
  }

  // Normalize the data (matching existing logic in receipt-dashboard.tsx)
  return data.receipts.map((r: Receipt) => ({
    ...r,
    date: r.date || r.receipt_date,
    category: r.category || 'Uncategorized',
  }))
}

// Main query hook
export function useAdminReceipts({ enabled = true, ...params }: AdminReceiptsParams) {
  return useQuery({
    queryKey: adminReceiptsKeys.list(params),
    queryFn: () => fetchAdminReceipts(params),
    enabled,
  })
}

// Hook to invalidate all admin receipts queries (used after mutations)
export function useInvalidateAdminReceipts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: adminReceiptsKeys.all })
  }
}

// Delete mutation hook
export function useDeleteReceipt() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (receiptId: string) => {
      const response = await fetch(`/api/receipts?id=${receiptId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Failed to delete receipt')
      }

      return response.json()
    },
    onSuccess: () => {
      // Invalidate all admin receipts queries to refetch
      queryClient.invalidateQueries({ queryKey: adminReceiptsKeys.all })
    },
  })
}

// Update mutation hook
export function useUpdateReceipt() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Receipt> }) => {
      const response = await fetch(`/api/receipts?id=${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Failed to update receipt')
      }

      return response.json()
    },
    onSuccess: () => {
      // Invalidate all admin receipts queries to refetch
      queryClient.invalidateQueries({ queryKey: adminReceiptsKeys.all })
    },
  })
}
