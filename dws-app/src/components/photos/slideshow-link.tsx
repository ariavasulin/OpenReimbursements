"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Play } from "lucide-react";
import { headerActionClass } from "@/components/photos/collection-header";
import type { PhotoRow } from "@/lib/photos/types";

// The page header's Play button and the photo grid sit in different parts of
// the page: the header belongs to the page, the grid (and its viewer) below
// it. A page wraps both in <SlideshowLink>; the grid registers how to start a
// slideshow of its photos (or nothing, when none can play), and <PlayButton>
// calls it. Outside a <SlideshowLink> (the Photos page, which has no Play
// button) the registration is a no-op.

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
 * The registering half: `start` opens the viewer on the first photo and plays.
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

/**
 * The grid's half, kept out of the viewer: the viewer's code downloads a moment
 * after the grid's first page, and Play must not wait for it (it would pop in
 * late and push the header's Share button aside). Play shows as soon as
 * `photos` holds a still (videos never play in a slideshow); pressing it opens
 * the viewer on the first still with `autoplay` true. The viewer, once
 * mounted and open, starts playing and calls `autoplayStarted`.
 */
export function useSlideshowStart(
  photos: PhotoRow[],
  openPhoto: (photoId: string) => void,
  isOpen: boolean
): { autoplay: boolean; autoplayStarted(): void } {
  const [autoplay, setAutoplay] = useState(false);
  const firstStill = photos.find((photo) => photo.kind !== "video");
  // One function for as long as there is a still, so the header is not
  // re-registered on every new page of photos.
  const startRef = useRef<() => void>(() => {});
  startRef.current = () => {
    if (!firstStill) return;
    setAutoplay(true);
    openPhoto(firstStill.id);
  };
  const start = useCallback(() => startRef.current(), []);
  useRegisterSlideshow(firstStill ? start : null);
  // A viewer closed (or never shown) before it could start forgets the ask,
  // so a later tap on a tile does not play.
  useEffect(() => {
    if (!isOpen) setAutoplay(false);
  }, [isOpen]);
  const autoplayStarted = useCallback(() => setAutoplay(false), []);
  return { autoplay: autoplay && isOpen, autoplayStarted };
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
