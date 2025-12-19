import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminUser } from '@/lib/types'

// Query key factory for consistent cache keys
export const adminUsersKeys = {
  all: ['admin-users'] as const,
  list: () => ['admin-users', 'list'] as const,
}

// Fetch function
async function fetchAdminUsers(): Promise<AdminUser[]> {
  const response = await fetch("/api/admin/users?perPage=1000")
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error || "Failed to fetch users")
  }

  return data.users || []
}

// Main query hook
export function useAdminUsers({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminUsersKeys.list(),
    queryFn: fetchAdminUsers,
    enabled,
  })
}

// Hook to invalidate admin users (used after create/update/delete)
export function useInvalidateAdminUsers() {
  const queryClient = useQueryClient()

  return () => {
    queryClient.invalidateQueries({ queryKey: adminUsersKeys.all })
  }
}

// Export fetch function for prefetching
export { fetchAdminUsers }
