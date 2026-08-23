"use client";

import { useEffect, useRef, useState } from "react";

// Anything smaller than this is a URL-bar collapse, not a keyboard.
const MIN_KEYBOARD_PX = 150;

// Height of the software keyboard overlapping the layout viewport, in px.
// iOS Safari shrinks only the visual viewport for the keyboard, so
// `innerHeight - vv.height - vv.offsetTop` is the one signal available.
// Pure so the threshold can be unit-tested without a DOM.
export function keyboardInsetFrom(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number
): number {
  const next = Math.max(0, innerHeight - vvHeight - vvOffsetTop);
  return next >= MIN_KEYBOARD_PX ? next : 0;
}

// 0 when no keyboard, when disabled, or where visualViewport is unsupported.
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  const lastRef = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;
    // resize and scroll fire together while the keyboard animates; coalesce
    // them into one measurement per frame and only re-render on a change.
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const next = keyboardInsetFrom(window.innerHeight, vv.height, vv.offsetTop);
      if (next !== lastRef.current) {
        lastRef.current = next;
        setInset(next);
      }
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    measure();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      lastRef.current = 0;
      setInset(0);
    };
  }, [enabled]);
  return inset;
}
