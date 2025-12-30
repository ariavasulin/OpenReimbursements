import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Receipt } from '@/lib/types'
import { supabase } from '@/lib/supabaseClient'

// Query key factory for consistent cache keys
export const pendingReceiptsKeys = {
  all: ['pending-receipts'] as const,
  list: () => ['pending-receipts', 'list'] as const,
}

// Fetch function - queries Supabase directly for pending receipts
async function fetchPendingReceipts(): Promise<Receipt[]> {
  const { data, error } = await supabase
    .from("receipts")
    .select(
      `
      id,
      receipt_date,
      amount,
      status,
      category_id,
      categories!receipts_category_id_fkey (name),
      description,
      image_url,
      user_profiles (
        full_name,
        employee_id_internal
      )
    `
    )
    .eq("status", "Pending")
    .order("created_at", { ascending: false })

  if (error) throw error

  // Map to Receipt interface
  return (data || []).map((item: any) => ({
    id: item.id,
    employeeName: item.user_profiles?.full_name || "N/A",
    employeeId: item.user_profiles?.employee_id_internal || "N/A",
    date: item.receipt_date,
    amount: item.amount,
    category: item.categories?.name || "Uncategorized",
    description: item.description || "",
    status: item.status.toLowerCase() as Receipt['status'],
    image_url: item.image_url
      ? supabase.storage.from('receipt-images').getPublicUrl(item.image_url).data.publicUrl
      : "",
  }))
}

// Main query hook
export function usePendingReceipts({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: pendingReceiptsKeys.list(),
    queryFn: fetchPendingReceipts,
    enabled,
  })
}

// Hook to invalidate pending receipts (used after batch submit)
export function useInvalidatePendingReceipts() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: pendingReceiptsKeys.all })
  }
}

// Export fetch function for prefetching
export { fetchPendingReceipts }
