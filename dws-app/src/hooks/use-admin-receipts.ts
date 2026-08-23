import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/photos/api'
import { toDbReceiptStatus, type Receipt, type ReceiptSort, type ReceiptStatusFilter } from '@/lib/types'

export interface AdminReceiptsFilter {
  status?: ReceiptStatusFilter
  fromDate?: string
  toDate?: string
  /** Free-text search over employee name and description, applied server-side. */
  search?: string
}

interface AdminReceiptsParams extends AdminReceiptsFilter {
  sort?: ReceiptSort | null
  page?: number
  pageSize?: number
  enabled?: boolean
}

/** Query string shared by the receipts page and the CSV export, so the two describe one set. */
export function adminReceiptsFilterParams(filter: AdminReceiptsFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (filter.status && filter.status !== 'all') params.set('status', toDbReceiptStatus(filter.status))
  if (filter.fromDate) params.set('fromDate', filter.fromDate)
  if (filter.toDate) params.set('toDate', filter.toDate)
  if (filter.search) params.set('q', filter.search)
  return params
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
  const urlParams = adminReceiptsFilterParams(params)
  if (params.sort) {
    urlParams.set('sort', params.sort.field)
    urlParams.set('dir', params.sort.direction)
  }
  if (params.page) urlParams.set('page', String(params.page))
  if (params.pageSize) urlParams.set('pageSize', String(params.pageSize))

  const data = await fetchJson<AdminReceiptsPage>(
    `/api/admin/receipts?${urlParams.toString()}`,
    'Failed to fetch receipts'
  )

  return {
    receipts: data.receipts.map((r: Receipt) => ({
      ...r,
      date: r.date || r.receipt_date || '',
      category: r.category || 'Uncategorized',
    })),
    totalCount: data.totalCount,
    totalAmount: data.totalAmount,
  }
}

export function useAdminReceipts({ enabled = true, ...params }: AdminReceiptsParams) {
  return useQuery({
    queryKey: adminReceiptsKeys.list(params),
    queryFn: () => fetchAdminReceipts(params),
    enabled,
    // Every filter, sort and page is part of the key. Without this each change
    // drops `data` to undefined mid-fetch: the table unmounts, the totals read
    // 0, and the pager computes a page count of 1.
    placeholderData: keepPreviousData,
  })
}

async function fetchAdminReceiptCounts(params: AdminReceiptCountsParams): Promise<AdminReceiptCounts> {
  const urlParams = new URLSearchParams()
  if (params.fromDate) urlParams.append('fromDate', params.fromDate)
  if (params.toDate) urlParams.append('toDate', params.toDate)

  const qs = urlParams.toString()
  const data = await fetchJson<{ counts: AdminReceiptCounts }>(
    `/api/admin/receipts/status-counts${qs ? `?${qs}` : ''}`,
    'Failed to fetch receipt counts'
  )
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
