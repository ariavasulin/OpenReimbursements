'use client'

import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { supabase } from '@/lib/supabaseClient'

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined = undefined

function getQueryClient() {
  if (typeof window === 'undefined') {
    return makeQueryClient()
  } else {
    if (!browserQueryClient) {
      browserQueryClient = makeQueryClient()
    }
    return browserQueryClient
  }
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())
  // undefined = no identity observed yet, so the first observation is the
  // baseline rather than a transition.
  const lastIdentityRef = useRef<string | null | undefined>(undefined)

  // Drop the whole cache whenever the signed-in identity changes: the
  // QueryClient is a module-level singleton with a 5-minute staleTime, so
  // cached data must not survive an identity change.
  useEffect(() => {
    const observe = (userId: string | null) => {
      if (lastIdentityRef.current === undefined) {
        lastIdentityRef.current = userId
        return
      }
      if (lastIdentityRef.current === userId) return
      lastIdentityRef.current = userId
      queryClient.clear()
    }

    // The subscription's INITIAL_SESSION event sets the baseline.
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => observe(session?.user?.id ?? null)
    )

    return () => authListener?.subscription?.unsubscribe()
  }, [queryClient])

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
