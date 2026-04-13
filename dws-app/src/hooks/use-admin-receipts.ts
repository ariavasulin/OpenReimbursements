import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Receipt } from '@/lib/types'

interface AdminReceiptsParams {
  status?: string
  fromDate?: string
  toDate?: string
  enabled?: boolean
}

export const adminReceiptsKeys = {
  all: ['admin-receipts'] as const,
  list: (params: AdminReceiptsParams) => ['admin-receipts', params] as const,
}

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

  return data.receipts.map((r: Receipt) => ({
    ...r,
    date: r.date || r.receipt_date,
    category: r.category || 'Uncategorized',
  }))
}

export function useAdminReceipts({ enabled = true, ...params }: AdminReceiptsParams) {
  return useQuery({
    queryKey: adminReceiptsKeys.list(params),
    queryFn: () => fetchAdminReceipts(params),
    enabled,
  })
}

export function useInvalidateAdminReceipts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: adminReceiptsKeys.all })
  }
}

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
      queryClient.invalidateQueries({ queryKey: adminReceiptsKeys.all })
    },
  })
}
