import { createBrowserClient } from "@supabase/ssr"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error("Missing environment variable NEXT_PUBLIC_SUPABASE_URL")
}
if (!supabaseAnonKey) {
  throw new Error("Missing environment variable NEXT_PUBLIC_SUPABASE_ANON_KEY")
}

// Lazily create the browser client only when running in the browser so that
// server-side rendering doesn't attempt to touch window/localStorage.
const createClient = () => createBrowserClient(supabaseUrl, supabaseAnonKey)

export const supabase =
  typeof window === "undefined"
    ? (null as unknown as ReturnType<typeof createClient>)
    : createClient()
