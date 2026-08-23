"use client";

import { useEffect, useState } from "react";

/**
 * The same media query as the `desktop:` Tailwind variant in globals.css;
 * use-desktop.test.ts compares the two, ignoring whitespace.
 */
export const DESKTOP_MQ = "(min-width: 1024px) and (hover: hover)";

/**
 * True on a wide screen with a real pointer. SSR and first paint are false, so
 * the phone layout is what renders before hydration — never a desktop flash.
 *
 * Deliberately a different population from `useMobile` (UA-based), which
 * picks the sheet variant (Drawer vs Dialog): that one asks "is this a
 * phone", this one asks "is there room and a pointer for desktop chrome".
 */
export function useDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_MQ);
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isDesktop;
}
