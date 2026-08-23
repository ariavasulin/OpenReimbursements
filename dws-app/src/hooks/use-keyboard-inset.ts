"use client";

import { useEffect, useState } from "react";

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
  useEffect(() => {
    if (!enabled) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setInset(keyboardInsetFrom(window.innerHeight, vv.height, vv.offsetTop));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setInset(0);
    };
  }, [enabled]);
  return inset;
}
