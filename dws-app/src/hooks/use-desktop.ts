"use client";

import { useSyncExternalStore } from "react";

/**
 * The same media query as the `desktop:` Tailwind variant in globals.css;
 * use-desktop.test.ts compares the two, ignoring whitespace.
 */
export const DESKTOP_MQ = "(min-width: 1024px) and (hover: hover)";

// One MediaQueryList and one "change" listener for the whole page, however
// many components ask: every photo grid, project card and sheet calls this.
let desktopQuery: MediaQueryList | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function query(): MediaQueryList {
  desktopQuery ??= window.matchMedia(DESKTOP_MQ);
  return desktopQuery;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) query().addEventListener("change", notify);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) query().removeEventListener("change", notify);
  };
}

const getSnapshot = () => query().matches;
const getServerSnapshot = () => false;

/**
 * True on a wide screen with a real pointer. The server render and hydration
 * use false, so the phone layout is what renders before hydration — never a
 * desktop flash — and React re-renders with the real answer straight after.
 * A component that mounts later (a tile on a new page, a card, the viewer)
 * reads the real answer in its first render instead of rendering the phone
 * layout once and flipping in an effect.
 *
 * Deliberately a different population from `useMobile` (UA-based), which
 * picks the sheet variant (Drawer vs Dialog): that one asks "is this a
 * phone", this one asks "is there room and a pointer for desktop chrome".
 */
export function useDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
