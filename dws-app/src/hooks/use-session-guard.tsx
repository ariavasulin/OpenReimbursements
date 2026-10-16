"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { clearPersistedQueries } from "@/lib/query-persist-browser";

/**
 * Session-only guard (no role gate): redirects to /login?next=<path and query>
 * when there is no session or the user signs out. Returns true once verified.
 *
 * Checks once per mount, not per navigation: the photos shell stays mounted
 * across /photos pages, and the SIGNED_OUT listener below already catches a
 * session that ends later (including a token refresh that fails). Re-arming on
 * every tap cost a getSession() auth lock, a cookie parse and a resubscribe.
 * `_path` is unused; it stays so existing callers compile.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useSessionGuard(_path?: string): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Read at redirect time, so `?next=` carries the page and query the
    // person is on at that moment, not the one this guard mounted on.
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
  }, []);

  return ready;
}

/**
 * The auth cookie is apex-scoped (e.g. .dws-receipts.com), so this signs out of
 * Receipts too — intended: one account. The session guard handles the redirect.
 * The photo lists saved on this device go first: the redirect is a full page
 * load, which could cut off a delete started after it.
 */
export async function signOut(): Promise<void> {
  await clearPersistedQueries();
  await supabase.auth.signOut();
}

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
