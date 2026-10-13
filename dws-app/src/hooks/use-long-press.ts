"use client";

import { useEffect, useRef } from "react";

/** How long a press must last to start selecting, and how far it may drift. */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_DRIFT_PX = 10;

/**
 * Press and hold, the phone's way to start selecting a photo, album, or
 * project. Spread `handlers` on the element; pass `null` to turn it off.
 *
 * The click that follows a hold must not also open or toggle the item, so
 * call `takeHold()` first in the click handler: it is true once after a hold.
 */
export function useLongPress(onHold: (() => void) | null) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);

  const handlers = onHold
    ? {
        onPointerDown: (event: React.PointerEvent) => {
          if (event.button !== 0) return;
          held.current = false;
          cancel();
          press.current = {
            x: event.clientX,
            y: event.clientY,
            timer: setTimeout(() => {
              press.current = null;
              held.current = true;
              navigator.vibrate?.(10);
              onHold();
            }, LONG_PRESS_MS),
          };
        },
        onPointerMove: (event: React.PointerEvent) => {
          const start = press.current;
          if (!start) return;
          if (
            Math.abs(event.clientX - start.x) > LONG_PRESS_DRIFT_PX ||
            Math.abs(event.clientY - start.y) > LONG_PRESS_DRIFT_PX
          ) {
            cancel();
          }
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
        // A long press on a phone otherwise opens the browser's image or link menu.
        onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
      }
    : {};

  const takeHold = () => {
    if (!held.current) return false;
    held.current = false;
    return true;
  };

  return { handlers, takeHold };
}
