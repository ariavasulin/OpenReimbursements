"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/**
 * Session-only guard (no role gate): redirects to /login?next=<path and query>
 * when there is no session or the user signs out. Returns true once verified.
 *
 * Only `pathname` re-arms the check, never the query string: arming costs a
 * getSession() token refresh and an onAuthStateChange resubscribe whose own
 * INITIAL_SESSION emit can redirect, and the lightbox rewrites `?photo=<id>`
 * in place once per slide.
 */
export function useSessionGuard(pathname: string): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Read at redirect time, so `?next=` carries the query string as it stands.
    const toLogin = () =>
      window.location.replace(
        `/login?next=${encodeURIComponent(
          `${window.location.pathname}${window.location.search}`
        )}`
      );

    const guard = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        toLogin();
        return;
      }
      setReady(true);
    };
    guard();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          toLogin();
        }
      }
    );
    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, [pathname]);

  return ready;
}

/**
 * The auth cookie is apex-scoped (.dws-receipts.com), so this signs out of
 * Receipts too — intended: one account. The session guard handles the redirect.
 */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Full-height AuthLoading. */
export const PHOTOS_AUTH_LOADING_CLASS =
  "flex h-dvh items-center justify-center bg-[#222222] px-4 text-white";

export function AuthLoading({
  className = "flex min-h-full items-center justify-center px-4 py-8",
}: {
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-center">
        <p className="mb-2 text-lg">Loading...</p>
        <p className="text-sm text-gray-400">Verifying authentication</p>
      </div>
    </div>
  );
}
