"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Play } from "lucide-react";
import { headerActionClass } from "@/components/photos/collection-header";

// The page header's Play button and the photo viewer sit in different parts of
// the page: the header belongs to the page, the viewer to the photo grid below
// it. A page wraps both in <SlideshowLink>; the viewer registers how to start a
// slideshow of the grid's photos (or nothing, when none can play), and
// <PlayButton> calls it. Outside a <SlideshowLink> (the Photos page, which has
// no Play button) the viewer's registration is a no-op.

interface SlideshowLinkValue {
  start: (() => void) | null;
  setStart(start: (() => void) | null): void;
}

const SlideshowLinkContext = createContext<SlideshowLinkValue | null>(null);

export function SlideshowLink({ children }: { children: ReactNode }) {
  const [start, setStartState] = useState<(() => void) | null>(null);
  // A function is a state *updater* to React, so wrap it.
  const setStart = useCallback(
    (next: (() => void) | null) => setStartState(() => next),
    []
  );
  const value = useMemo(() => ({ start, setStart }), [start, setStart]);
  return (
    <SlideshowLinkContext.Provider value={value}>
      {children}
    </SlideshowLinkContext.Provider>
  );
}

/**
 * The viewer's half: `start` opens the viewer on the first photo and plays.
 * Pass null while there is nothing to play (no photos, or videos only).
 * Pass a stable function; a new one each render re-registers each render.
 */
export function useRegisterSlideshow(start: (() => void) | null): void {
  const setStart = useContext(SlideshowLinkContext)?.setStart;
  useEffect(() => {
    if (!setStart) return;
    setStart(start);
    return () => setStart(null);
  }, [start, setStart]);
}

/** "Play" in a page header; absent until the grid has a photo to play. */
export function PlayButton() {
  const start = useContext(SlideshowLinkContext)?.start;
  if (!start) return null;
  return (
    <button type="button" onClick={start} className={headerActionClass}>
      <Play className="h-4 w-4" aria-hidden="true" />
      Play
    </button>
  );
}
