"use client";

import { useEffect, useRef, type PointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchCollection, type CollectionTarget } from "@/lib/photos/api";

/** A mouse resting this long on a link is heading for it; one sweeping past is not. */
export const HOVER_INTENT_MS = 80;

/**
 * Starts loading what a project or album link opens as soon as someone shows
 * they mean to open it: a mouse resting on it, keyboard focus resting on it,
 * or a finger touching down (about 100 ms before the tap ends). Never just
 * because the link is on screen. Spread the result onto the link. Shared by
 * the list cards and the desktop rail, so both start the same loads the same
 * way. Focus waits like a mouse does: holding an arrow key down the rail
 * passes dozens of rows, and only the one it stops on should load.
 *
 * Its own small module (not inside a card) because the rail is part of every
 * /photos page's first load: importing the card would bring the photo grid
 * along with it.
 */
export function usePrefetchOnIntent(target: CollectionTarget | undefined) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  if (!target) return {};
  const now = () => {
    cancel();
    prefetchCollection(queryClient, target);
  };
  const soon = () => {
    cancel();
    timer.current = setTimeout(now, HOVER_INTENT_MS);
  };
  return {
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === "mouse") soon();
    },
    onPointerLeave: cancel,
    onFocus: soon,
    onBlur: cancel,
    onTouchStart: now,
  };
}
