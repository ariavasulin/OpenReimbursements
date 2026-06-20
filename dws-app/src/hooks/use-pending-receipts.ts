import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Receipt } from '@/lib/types'

export const pendingReceiptsKeys = {
  all: ['pending-receipts'] as const,
  list: () => ['pending-receipts', 'list'] as const,
}

async function fetchPendingReceipts(): Promise<Receipt[]> {
  const response = await fetch('/api/receipts/pending')
  const result = await response.json()

  if (!response.ok) {
    throw new Error(result.error || 'Failed to fetch pending receipts')
  }

  return (result.receipts || []) as Receipt[]
}

export function usePendingReceipts({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pendingReceiptsKeys.list(),
    queryFn: fetchPendingReceipts,
    enabled,
  })
}

export function useInvalidatePendingReceipts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: pendingReceiptsKeys.all })
  }
}

export { fetchPendingReceipts }
