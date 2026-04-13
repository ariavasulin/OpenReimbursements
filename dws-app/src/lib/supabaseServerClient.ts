import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

const SIX_MONTHS_SECONDS = 60 * 60 * 24 * 180;

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

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

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