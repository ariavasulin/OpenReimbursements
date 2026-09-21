"use client";

import { createContext, useContext } from "react";
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
  /** Search text — the single copy; /photos/search seeds it from `?q=`. */
  query: string;
  setQuery(value: string): void;
  /** 250ms-debounced `query`; this is what goes into the react-query key. */
  debouncedQuery: string;
  /** The desktop photo viewer reports itself open here; the shell's drop
   *  intake treats that as busy, like an open sheet or camera. */
  setViewerOpen(open: boolean): void;
}

export const PhotosShellContext = createContext<PhotosShellValue | null>(null);

export function usePhotosShell(): PhotosShellValue {
  const value = useContext(PhotosShellContext);
  if (!value) {
    throw new Error("usePhotosShell must be used inside <PhotosShell>");
  }
  return value;
}
