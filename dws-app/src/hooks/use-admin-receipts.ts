import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import { Receipt, toDbReceiptStatus } from '@/lib/types'

interface AdminReceiptsParams {
  status?: string
  fromDate?: string
  toDate?: string
  page?: number
  pageSize?: number
  enabled?: boolean
}

export interface AdminReceiptsPage {
  receipts: Receipt[]
  totalCount: number
  totalAmount: number
}

interface AdminReceiptCountsParams {
  fromDate?: string
  toDate?: string
  enabled?: boolean
}

export interface AdminReceiptCounts {
  pending: number
  approved: number
  rejected: number
  reimbursed: number
  total: number
}

export const adminReceiptsKeys = {
  all: ['admin-receipts'] as const,
  list: (params: AdminReceiptsParams) => ['admin-receipts', params] as const,
  counts: (params: AdminReceiptCountsParams) => ['admin-receipts', 'counts', params] as const,
}

async function fetchAdminReceipts(params: AdminReceiptsParams): Promise<AdminReceiptsPage> {
  const urlParams = new URLSearchParams()

  if (params.status && params.status !== 'all') {
    urlParams.append('status', toDbReceiptStatus(params.status))
  }

  if (params.fromDate) {
    urlParams.append('fromDate', params.fromDate)
  }

  if (params.toDate) {
    urlParams.append('toDate', params.toDate)
  }

  if (params.page) {
    urlParams.append('page', String(params.page))
  }

  if (params.pageSize) {
    urlParams.append('pageSize', String(params.pageSize))
  }

  const data = await fetchJson<{
    success: boolean
    error?: string
    receipts: Receipt[]
    totalCount: number
    totalAmount: number
  }>(`/api/admin/receipts?${urlParams.toString()}`, 'Failed to fetch receipts')

  if (!data.success) {
    throw new Error(data.error || 'Failed to fetch receipts')
  }

  return {
    // The route always sends `date`; `receipt_date` is the fallback for rows
    // that predate it.
    receipts: data.receipts.map((r: Receipt) => ({
      ...r,
      date: r.date || r.receipt_date,
      category: r.category || 'Uncategorized',
    })) as Receipt[],
    totalCount: data.totalCount,
    totalAmount: data.totalAmount,
  }
}

export function useAdminReceipts({ enabled = true, ...params }: AdminReceiptsParams) {
  return useQuery({
    queryKey: adminReceiptsKeys.list(params),
    queryFn: () => fetchAdminReceipts(params),
    enabled,
  })
}

async function fetchAdminReceiptCounts(params: AdminReceiptCountsParams): Promise<AdminReceiptCounts> {
  const urlParams = new URLSearchParams()
  if (params.fromDate) urlParams.append('fromDate', params.fromDate)
  if (params.toDate) urlParams.append('toDate', params.toDate)

  const qs = urlParams.toString()
  const data = await fetchJson<{
    success: boolean
    error?: string
    counts: AdminReceiptCounts
  }>(
    `/api/admin/receipts/status-counts${qs ? `?${qs}` : ''}`,
    'Failed to fetch receipt counts'
  )
  if (!data.success) {
    throw new Error(data.error || 'Failed to fetch receipt counts')
  }
  return data.counts
}

export function useAdminReceiptCounts({ enabled = true, ...params }: AdminReceiptCountsParams) {
  return useQuery({
    queryKey: adminReceiptsKeys.counts(params),
    queryFn: () => fetchAdminReceiptCounts(params),
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
