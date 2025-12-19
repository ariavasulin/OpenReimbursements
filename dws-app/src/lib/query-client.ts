import { QueryClient } from '@tanstack/react-query'

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data considered fresh for 5 minutes - no refetch on tab switch
        staleTime: 5 * 60 * 1000,
        // Cache kept for 10 minutes after last use
        gcTime: 10 * 60 * 1000,
        // Don't refetch on window focus (can enable later if desired)
        refetchOnWindowFocus: false,
        // Retry failed requests once
        retry: 1,
      },
    },
  })
}

// Singleton for client-side
let browserQueryClient: QueryClient | undefined = undefined

export function getQueryClient() {
  if (typeof window === 'undefined') {
    // Server: always make a new query client
    return makeQueryClient()
  } else {
    // Browser: reuse client across renders
    if (!browserQueryClient) {
      browserQueryClient = makeQueryClient()
    }
    return browserQueryClient
  }
}
