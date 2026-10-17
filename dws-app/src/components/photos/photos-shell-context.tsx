"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UploadTarget } from "@/hooks/use-capture-batch";

// Separate module so TopBar, JobsRail, and capture-bar can consume the shell
// without importing photos-shell.tsx, which imports them back.

/** id of the shell's scroll container — the scroll root everything else uses. */
export const PHOTOS_SCROLLPORT_ID = "photos-scrollport";

/**
 * id of the shell's floating column, anchored to the bottom of the content
 * area above the phone tab bar. The "+" button and the upload tray live in it;
 * a page's selection bar portals into it, so the three stack instead of
 * overlapping whatever the text size.
 */
export const PHOTOS_FLOATING_SLOT_ID = "photos-floating-slot";

/** The three ways to browse. null on pages that belong to none (search, trash). */
export type PhotoSection = "photos" | "albums" | "projects";

export function photoSection(
  pathname: string,
  params: { jobId?: string; albumId?: string }
): PhotoSection | null {
  if (pathname === "/photos") return "photos";
  if (pathname.startsWith("/photos/albums")) return "albums";
  if (pathname === "/photos/projects" || params.jobId) return "projects";
  return null;
}

export interface PhotosShellValue {
  /** Opens the native multi-select picker. */
  openPicker(): void;
  /** Opens the in-app multi-shot camera. */
  openCamera(): void;
  /** Files from anywhere (drop, a future TopBar path) into the batch sheet. */
  openSheet(
    files: File[],
    target?: UploadTarget,
    capturedAtOverrides?: Map<File, Date>
  ): void;
  /** Opens the "New project" pop-up; creating one (or choosing an existing
   *  match) opens its page. */
  openNewProject(): void;
  /** Opens the "New album" pop-up; creating one opens its page. */
  openNewAlbum(): void;
  /** From useParams(); jobs are UUIDs so there is no collision with "search". */
  activeJobId: string | null;
  /** The album whose page is open, or null. */
  activeAlbumId: string | null;
  section: PhotoSection | null;
  /** A page reports that photos are selected; the shell hides the "+" button
   *  so the selection bar can take its place. */
  setSelecting(selecting: boolean): void;
  /** Sets the search text (see usePhotosSearch); /photos/search seeds it from `?q=`. */
  setQuery(value: string): void;
  /** The desktop photo viewer reports itself open here; the shell's drop
   *  intake treats that as busy, like an open sheet or camera. */
  setViewerOpen(open: boolean): void;
}

// Two contexts, so typing in the search box re-renders the search box and not
// the page under it: the shell's value (actions and where you are) keeps one
// identity while you type, and only the few readers of the search text
// subscribe to it. Every page calls usePhotosShell() for an open* action; if
// the text lived in the same value, each keystroke would re-render the open
// page and every photo tile on it.

export const PhotosShellContext = createContext<PhotosShellValue | null>(null);

/** The shell's actions and where you are. Its identity changes only on navigation. */
export function usePhotosShell(): PhotosShellValue {
  const value = useContext(PhotosShellContext);
  if (!value) {
    throw new Error("usePhotosShell must be used inside <PhotosShell>");
  }
  return value;
}

export interface PhotosSearchValue {
  /** Search text — the single copy; /photos/search seeds it from `?q=`. */
  query: string;
  setQuery(value: string): void;
  /** 250ms-debounced `query`; this is what goes into the react-query key. */
  debouncedQuery: string;
}

const PhotosSearchContext = createContext<PhotosSearchValue | null>(null);
const SetPhotosQueryContext = createContext<((value: string) => void) | null>(null);

/**
 * Holds the search text above the shell. Its own component, so a keystroke
 * re-renders only this provider and the components reading usePhotosSearch():
 * its children are the same elements as before and React skips them.
 */
export function PhotosSearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const value = useMemo(
    () => ({ query, setQuery, debouncedQuery }),
    [query, debouncedQuery]
  );
  return (
    <SetPhotosQueryContext.Provider value={setQuery}>
      <PhotosSearchContext.Provider value={value}>{children}</PhotosSearchContext.Provider>
    </SetPhotosQueryContext.Provider>
  );
}

/** The search text, for the search box. Re-renders on every keystroke. */
export function usePhotosSearch(): PhotosSearchValue {
  const value = useContext(PhotosSearchContext);
  if (!value) {
    throw new Error("usePhotosSearch must be used inside <PhotosSearchProvider>");
  }
  return value;
}

/** The search text's setter alone; never re-renders on a keystroke. */
export function useSetPhotosQuery(): (value: string) => void {
  const setQuery = useContext(SetPhotosQueryContext);
  if (!setQuery) {
    throw new Error("useSetPhotosQuery must be used inside <PhotosSearchProvider>");
  }
  return setQuery;
}
