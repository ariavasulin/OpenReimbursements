import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Extend the lifetime of the auth cookies to ~6 months (in seconds)
const SIX_MONTHS_SECONDS = 60 * 60 * 24 * 180; // 15,552,000 seconds

// Helper to merge the caller-provided CookieOptions with our long-expiry defaults
const withLongExpiry = (options: CookieOptions = {}): CookieOptions => {
  return {
    ...options,
    maxAge: SIX_MONTHS_SECONDS,
    // Some browsers still rely on `expires`, so set both.
    expires: new Date(Date.now() + SIX_MONTHS_SECONDS * 1000),
    path: options.path ?? '/',
    sameSite: options.sameSite ?? 'lax',
    secure: options.secure ?? process.env.NODE_ENV === 'production',
  };
};

export async function createSupabaseServerClient() { // Make function async
  const cookieStore = await cookies(); // Await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          cookieStore.set(name, value, withLongExpiry(options));
        },
        // When removing, we keep the long-expiry options so that the cookie is
        // cleared consistently across browsers.
        remove(name: string, options: CookieOptions) {
          cookieStore.set(name, '', withLongExpiry(options));
        },
      },
    }
  );
}

// Admin client using service role key - bypasses RLS for server-side operations
export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseServiceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for admin operations');
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}