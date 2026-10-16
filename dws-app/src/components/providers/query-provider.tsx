'use client'

import { useEffect, useState } from 'react'
import { QueryClient, type Query } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { supabase } from '@/lib/supabaseClient'
import {
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
} from '@/lib/query-persist'
import {
  clearPersistedQueries,
  queryPersister,
  setPersistOwner,
} from '@/lib/query-persist-browser'

function makeQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
  // A query leaves the cache gcTime after nothing shows it, and the next save
  // then drops it from the device too. The full project and album lists and
  // the settings are small and needed on most launches, so they stay as long
  // as a saved cache may be used. Grids keep the 10 minutes: they are large.
  for (const queryKey of [['photo-jobs', ''], ['photo-albums', ''], ['photo-settings']]) {
    client.setQueryDefaults(queryKey, { gcTime: PERSIST_MAX_AGE_MS })
  }
  return client
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

// The signed-in identity the browser cache belongs to. Module-level, like the
// cache itself, so a provider that remounts (each area of the site mounts its
// own) does not take a new baseline and miss a change of person.
// undefined = no identity observed yet, so the first observation is the
// baseline rather than a transition.
let lastIdentity: string | null | undefined = undefined

const persistOptions = {
  persister: queryPersister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: PERSIST_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: (query: Query) =>
      query.state.status === 'success' && shouldPersistQuery(query.queryKey),
    shouldDehydrateMutation: () => false,
  },
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())

  // Drop the whole cache, in memory and on the device, whenever the signed-in
  // identity changes: the QueryClient is a module-level singleton with a
  // 5-minute staleTime, and the photo query keys carry no user id, so cached
  // data must not survive an identity change. (The saved cache also records
  // its owner and is refused at restore by anyone else; see query-persist.ts.)
  useEffect(() => {
    const observe = (userId: string | null) => {
      setPersistOwner(userId)
      if (lastIdentity === undefined) {
        lastIdentity = userId
        return
      }
      if (lastIdentity === userId) return
      lastIdentity = userId
      queryClient.clear()
      void clearPersistedQueries()
    }

    // The subscription's INITIAL_SESSION event sets the baseline.
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => observe(session?.user?.id ?? null)
    )

    return () => authListener?.subscription?.unsubscribe()
  }, [queryClient])

  // Lists saved on this device paint at once on a cold launch, then refresh
  // in the background (restored entries are marked stale). While the saved
  // cache is being read, queries wait instead of fetching.
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </PersistQueryClientProvider>
  )
}
