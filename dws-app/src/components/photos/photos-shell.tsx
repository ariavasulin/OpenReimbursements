"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  AuthLoading,
  PHOTOS_AUTH_LOADING_CLASS,
  useSessionGuard,
} from "@/hooks/use-session-guard";
import { useDesktop } from "@/hooks/use-desktop";
import { useCaptureBatch, type UploadTarget } from "@/hooks/use-capture-batch";
import { pickerAccept, readInputFiles } from "@/lib/photos/batch";
import DropZone from "@/components/photos/drop-zone";
import MultiShotCamera from "@/components/photos/multi-shot-camera";
import NewAlbumSheet from "@/components/photos/new-album-sheet";
import { AddButton, BottomNav } from "@/components/photos/section-nav";
import SectionsRail from "@/components/photos/sections-rail";
import TopBar from "@/components/photos/top-bar";
import UploadSheet from "@/components/photos/upload-sheet";
import UploadTray from "@/components/photos/upload-tray";
import {
  PHOTOS_FLOATING_SLOT_ID,
  PHOTOS_SCROLLPORT_ID,
  PhotosShellContext,
  photoSection,
  type PhotosShellValue,
} from "@/components/photos/photos-shell-context";
import { usePhotoAlbum, usePhotoJobs } from "@/lib/photos/api";
import { jobLabel } from "@/lib/photos/format";

/** Pages that are a focused task, not browsing: no "+" button over them. */
const NO_ADD_BUTTON = ["/photos/actions", "/photos/trash"];

/**
 * The /photos frame: owns the session guard (hoisted out of the pages), the
 * scroll container, the navigation (phone tab bar, desktop top bar and rail),
 * the one capture batch, and every upload-intake mount (hidden picker input,
 * DropZone, UploadSheet, MultiShotCamera) — so the sheet outlives route
 * changes and pages only render content.
 */
export default function PhotosShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams<{ jobId?: string; albumId?: string }>();

  const ready = useSessionGuard(pathname);
  const isDesktop = useDesktop();
  const activeJobId = params?.jobId ?? null;
  const activeAlbumId = params?.albumId ?? null;
  const section = photoSection(pathname, params ?? {});

  const batch = useCaptureBatch();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // A selection belongs to the page that made it.
  useEffect(() => setSelecting(false), [pathname]);

  // For the drop overlay's label and the upload pop-up's pre-fill. Both are
  // deduped by react-query with the open page's identical query.
  const { data: jobsForLabel } = usePhotoJobs(
    ready && isDesktop && activeJobId !== null
  );
  const activeJob = jobsForLabel?.find((job) => job.id === activeJobId);
  const { data: activeAlbum } = usePhotoAlbum(
    activeAlbumId ?? "",
    ready && activeAlbumId !== null
  );

  // What the page you are on would upload into: its project, its album, or —
  // on Photos — neither, so the pop-up asks.
  const uploadTarget = useMemo<UploadTarget | undefined>(() => {
    if (activeJobId) return { jobId: activeJobId };
    if (activeAlbumId && activeAlbum?.id === activeAlbumId) {
      return { album: { id: activeAlbum.id, name: activeAlbum.name } };
    }
    return undefined;
  }, [activeJobId, activeAlbumId, activeAlbum]);

  const value: PhotosShellValue = {
    openPicker: () => fileInputRef.current?.click(),
    openCamera: () => batch.openCamera(uploadTarget),
    openSheet: batch.openSheet,
    openNewAlbum: () => setNewAlbumOpen(true),
    activeJobId,
    activeAlbumId,
    section,
    query,
    setQuery,
    debouncedQuery,
    setViewerOpen,
    setSelecting,
  };

  if (!ready) {
    return <AuthLoading className={PHOTOS_AUTH_LOADING_CLASS} />;
  }

  const showAddButton =
    !isDesktop && !selecting && !NO_ADD_BUTTON.includes(pathname);

  return (
    <PhotosShellContext.Provider value={value}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={pickerAccept()}
        onChange={(event) =>
          batch.openSheet(readInputFiles(event.target), uploadTarget)
        }
        className="sr-only"
      />

      <div className="flex h-dvh flex-col bg-[#222222] text-white">
        {isDesktop && <TopBar />}
        <div className="flex min-h-0 flex-1">
          {isDesktop && <SectionsRail />}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* With viewport-fit=cover this runs under the notch, so it pads by
                the top safe-area inset; the tab bar below pads the bottom. */}
            <div
              id={PHOTOS_SCROLLPORT_ID}
              // The desktop viewer lands focus here when the tile that opened
              // it no longer exists.
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] focus:outline-none desktop:pb-[env(safe-area-inset-bottom)]"
            >
              {children}
            </div>

            {/* The floating column: "+" on top, then a page's selection bar
                (portalled into the slot), then the upload tray. They stack, so
                none can cover another at any text size. Clicks pass through
                the empty parts of the column to the photos behind it. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-end gap-2 px-3 pb-3">
              {showAddButton && <AddButton />}
              <div id={PHOTOS_FLOATING_SLOT_ID} className="w-full empty:hidden" />
              <UploadTray />
            </div>
          </div>
        </div>
        {!isDesktop && <BottomNav />}
      </div>

      {/* Pointer-only: a touch device would never fire its window listeners. */}
      {isDesktop && (
        <DropZone
          onFiles={(files) => batch.openSheet(files, uploadTarget)}
          label={
            activeJob
              ? jobLabel(activeJob)
              : uploadTarget?.album
                ? uploadTarget.album.name
                : undefined
          }
          enabled={!batch.sheetOpen && !batch.cameraOpen && !viewerOpen}
          disabledReason={
            batch.cameraOpen
              ? "Close the camera before dropping files."
              : viewerOpen
                ? "Close the photo before dropping files."
                : undefined
          }
        />
      )}
      <UploadSheet
        files={batch.pickedFiles}
        open={batch.sheetOpen}
        onOpenChange={batch.setSheetOpen}
        defaultTarget={batch.sheetTarget}
        capturedAtOverrides={batch.capturedAtOverrides}
        sidecars={batch.sidecars}
      />
      <MultiShotCamera
        open={batch.cameraOpen}
        onClose={batch.closeCamera}
        onDone={batch.handleShotsDone}
      />
      <NewAlbumSheet
        open={newAlbumOpen}
        onOpenChange={setNewAlbumOpen}
        onCreated={(album) => router.push(`/photos/albums/${album.id}`)}
      />
    </PhotosShellContext.Provider>
  );
}
