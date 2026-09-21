"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * For a field whose suggestion list renders inline (it takes up room in the
 * pop-up): returns an onBlur handler that closes the list — but never in the
 * middle of a press.
 *
 * Pressing a button blurs the field on mouse-DOWN. Closing the list at that
 * moment shrinks the pop-up and moves the button out from under the pointer
 * before the mouse comes UP, so the click never lands ("Cancel" and "Add to
 * album" silently did nothing). So while a pointer is down the close waits for
 * it to lift, and for the click that follows.
 */
export function useCloseOnBlur(
  inputRef: RefObject<HTMLInputElement | null>,
  close: () => void
): () => void {
  const pointerDown = useRef(false);
  const pending = useRef(false);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const down = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
      if (!pending.current) return;
      pending.current = false;
      // After the click this pointer-up is about to produce.
      setTimeout(() => {
        if (document.activeElement !== inputRef.current) closeRef.current();
      }, 0);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, [inputRef]);

  return useCallback(() => {
    if (pointerDown.current) pending.current = true;
    else closeRef.current();
  }, []);
}
