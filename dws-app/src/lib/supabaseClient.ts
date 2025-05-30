import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("Missing environment variable NEXT_PUBLIC_SUPABASE_URL");
}
if (!supabaseAnonKey) {
  throw new Error("Missing environment variable NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

// This client is intended for use in browser/client components.
// For server-side operations (API routes, Server Components, Server Actions),
// create a new client using createServerClient or createRouteHandlerClient from @supabase/ssr.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);