'use client'

import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
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

/**
 * Drops the whole cache whenever the signed-in identity changes.
 *
 * The QueryClient is a module-level singleton with a 5-minute staleTime, so
 * cached data must not survive an identity change. A per-page handler cannot
 * do it — the page unmounts on navigation to /login.
 */
function AuthIdentityBoundary() {
  const queryClient = useQueryClient()
  // undefined = no identity observed yet, so the first observation is the
  // baseline rather than a transition.
  const lastIdentityRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false

    const observe = (userId: string | null) => {
      if (cancelled) return
      if (lastIdentityRef.current === undefined) {
        lastIdentityRef.current = userId
        return
      }
      if (lastIdentityRef.current === userId) return
      lastIdentityRef.current = userId
      queryClient.clear()
    }

    // getSession() and the INITIAL_SESSION event race; whichever lands first
    // sets the baseline and the other is a no-op (same identity).
    supabase.auth
      .getSession()
      .then(({ data }) => observe(data.session?.user?.id ?? null))

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => observe(session?.user?.id ?? null)
    )

    return () => {
      cancelled = true
      authListener?.subscription?.unsubscribe()
    }
  }, [queryClient])

  return null
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <AuthIdentityBoundary />
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
