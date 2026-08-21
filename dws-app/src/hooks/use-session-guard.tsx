"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/**
 * Session-only guard (no role gate): redirects to /login?next=<nextPath> when
 * there is no session or the user signs out. Returns true once verified.
 */
export function useSessionGuard(nextPath: string): boolean {
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const loginUrl = `/login?next=${encodeURIComponent(nextPath)}`;

    const guard = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mountedRef.current) return;
      if (!session) {
        window.location.replace(loginUrl);
        return;
      }
      setReady(true);
    };
    guard();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          window.location.replace(loginUrl);
        }
      }
    );
    return () => {
      mountedRef.current = false;
      authListener?.subscription?.unsubscribe();
    };
  }, [nextPath]);

  return ready;
}

/** The "Loading... / Verifying authentication" placeholder shown until ready. */
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
