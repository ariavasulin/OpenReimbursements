"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/**
 * Session-only guard (no role gate): redirects to /login?next=<pathname+search>
 * when there is no session or the user signs out. Returns true once verified.
 *
 * Only `pathname` re-runs the check, never the query string. Arming costs a
 * getSession() (a network token refresh inside the expiry margin) and an
 * onAuthStateChange resubscribe whose own INITIAL_SESSION emit can redirect, so
 * a page that rewrites its query string in place (the lightbox writes
 * `?photo=<id>` once per slide) must not re-arm it. The redirect still reads
 * the *latest* search, so `?next=` round-trips the query string.
 */
export function useSessionGuard(pathname: string, search = ""): boolean {
  const [ready, setReady] = useState(false);
  const nextPathRef = useRef("");
  nextPathRef.current = search ? `${pathname}?${search}` : pathname;

  useEffect(() => {
    let cancelled = false;
    const toLogin = () =>
      window.location.replace(
        `/login?next=${encodeURIComponent(nextPathRef.current)}`
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
