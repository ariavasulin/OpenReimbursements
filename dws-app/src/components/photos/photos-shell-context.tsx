"use client";

import { createContext, useContext } from "react";

// Separate module so TopBar, JobsRail, and capture-bar can consume the shell
// without importing photos-shell.tsx, which imports them back.

/** id of the shell's scroll container — the scroll root everything else uses. */
export const PHOTOS_SCROLLPORT_ID = "photos-scrollport";

export interface PhotosShellValue {
  /** Opens the native multi-select picker. */
  openPicker(): void;
  /** Opens the in-app multi-shot camera. */
  openCamera(): void;
  /** Files from anywhere (drop, a future TopBar path) into the batch sheet. */
  openSheet(
    files: File[],
    jobId?: string,
    capturedAtOverrides?: Map<File, Date>
  ): void;
  /** From useParams(); jobs are UUIDs so there is no collision with "search". */
  activeJobId: string | null;
  /** The search text, and the only copy of it: the TopBar input, each route's
   *  phone SearchInput, the rail, and the /photos overview all read it, so
   *  there is one control per route, they all agree, and there is one fetch.
   *  /photos/search seeds it from `?q=`. */
  query: string;
  setQuery(value: string): void;
  /** 250ms-debounced `query`; this is what goes into the react-query key. */
  debouncedQuery: string;
}

export const PhotosShellContext = createContext<PhotosShellValue | null>(null);

export function usePhotosShell(): PhotosShellValue {
  const value = useContext(PhotosShellContext);
  if (!value) {
    throw new Error("usePhotosShell must be used inside <PhotosShell>");
  }
  return value;
}
