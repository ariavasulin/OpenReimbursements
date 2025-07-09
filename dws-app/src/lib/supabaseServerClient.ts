import { createServerClient, type CookieOptions } from '@supabase/ssr';
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