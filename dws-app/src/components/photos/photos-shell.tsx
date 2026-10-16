"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSessionGuard } from "@/hooks/use-session-guard";
import { useDesktop } from "@/hooks/use-desktop";
import { useCaptureBatch, type UploadTarget } from "@/hooks/use-capture-batch";
import { pickerAccept, readInputFiles } from "@/lib/photos/batch";
import DropZone from "@/components/photos/drop-zone";
import MultiShotCamera from "@/components/photos/multi-shot-camera";
import { AddButton, BottomNav } from "@/components/photos/section-nav";
import SectionsRail from "@/components/photos/sections-rail";
import {
  PageSkeleton,
  RailSkeleton,
  TopBarSkeleton,
} from "@/components/photos/shell-skeleton";
import TopBar from "@/components/photos/top-bar";
import UploadTray from "@/components/photos/upload-tray";
import {
  PHOTOS_FLOATING_SLOT_ID,
  PHOTOS_SCROLLPORT_ID,
  PhotosSearchProvider,
  PhotosShellContext,
  photoSection,
  useSetPhotosQuery,
  type PhotosShellValue,
} from "@/components/photos/photos-shell-context";
import { usePhotoAlbum, usePhotoJob } from "@/lib/photos/api";
import { jobLabel } from "@/lib/photos/format";

// The pop-ups behind "+" load as their own chunks, not with the first page:
// nobody needs them before something is tapped. Each mounts the first time it
// opens (then stays, so it can animate closed), and the browser fetches all
// three when it is idle after the page is up, so the first open is instant.
// The camera stays static: the tab bar's camera check imports its module.
const loadUploadSheet = () => import("@/components/photos/upload-sheet");
const loadNewProjectSheet = () => import("@/components/photos/new-project-sheet");
const loadNewAlbumSheet = () => import("@/components/photos/new-album-sheet");
const UploadSheet = dynamic(loadUploadSheet, { ssr: false });
const NewProjectSheet = dynamic(loadNewProjectSheet, { ssr: false });
const NewAlbumSheet = dynamic(loadNewAlbumSheet, { ssr: false });

/** False until `open` is first true, then true for good. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/** Pages that are a focused task, not browsing: no "+" button over them. */
const NO_ADD_BUTTON = ["/photos/actions", "/photos/trash", "/photos/settings"];

/**
 * The /photos frame: owns the session guard (hoisted out of the pages), the
 * scroll container, the navigation (phone tab bar, desktop top bar and rail),
 * the one capture batch, and every upload-intake mount (hidden picker input,
 * DropZone, UploadSheet, MultiShotCamera) — so the sheet outlives route
 * changes and pages only render content.
 */
export default function PhotosShell({ children }: { children: ReactNode }) {
  return (
    <PhotosSearchProvider>
      <PhotosShellFrame>{children}</PhotosShellFrame>
    </PhotosSearchProvider>
  );
}

function PhotosShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams<{ jobId?: string; albumId?: string }>();

  const ready = useSessionGuard();
  const isDesktop = useDesktop();
  const activeJobId = params?.jobId ?? null;
  const activeAlbumId = params?.albumId ?? null;
  const section = photoSection(pathname, params ?? {});

  const batch = useCaptureBatch();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setQuery = useSetPhotosQuery();
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [newAlbumOpen, setNewAlbumOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // A selection belongs to the page that made it.
  useEffect(() => setSelecting(false), [pathname]);

  const uploadSheetMounted = useOpenedOnce(batch.sheetOpen);
  const newProjectMounted = useOpenedOnce(newProjectOpen);
  const newAlbumMounted = useOpenedOnce(newAlbumOpen);

  // Fetch the pop-ups' code once the page is up and the browser is idle.
  // Safari has no requestIdleCallback; a short timer stands in.
  useEffect(() => {
    if (!ready) return;
    const preload = () => {
      void loadUploadSheet();
      void loadNewProjectSheet();
      void loadNewAlbumSheet();
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(preload, 2000);
    return () => clearTimeout(timer);
  }, [ready]);

  // For the drop overlay's label and the upload pop-up's pre-fill. Both share
  // the project page's own one-project query, so opening a project never
  // waits on (or downloads) every project. Only active projects are found:
  // `null` means deleted or unknown, so that page is never an upload target.
  const { data: activeJobData } = usePhotoJob(ready ? activeJobId : null);
  const activeJob = activeJobData ?? undefined;
  const deadJob = activeJobId !== null && activeJobData === null;
  const { data: activeAlbum } = usePhotoAlbum(
    activeAlbumId ?? "",
    ready && activeAlbumId !== null
  );

  // What the page you are on would upload into: its project, its album, or —
  // on Photos — neither, so the pop-up asks.
  const uploadTarget = useMemo<UploadTarget | undefined>(() => {
    if (activeJob) return { jobId: activeJob.id };
    if (activeAlbumId && activeAlbum?.id === activeAlbumId) {
      return { album: { id: activeAlbum.id, name: activeAlbum.name } };
    }
    return undefined;
  }, [activeJob, activeAlbumId, activeAlbum]);

  // One identity until you navigate: every page reads this context, so a new
  // value would re-render the open page and its whole photo grid. Starting a
  // selection, opening the viewer, or the batch changing re-renders the shell
  // but not the page. The actions read the batch and the upload target
  // through refs, so they never go stale.
  const batchRef = useRef(batch);
  batchRef.current = batch;
  const uploadTargetRef = useRef(uploadTarget);
  uploadTargetRef.current = uploadTarget;
  const value = useMemo<PhotosShellValue>(
    () => ({
      openPicker: () => fileInputRef.current?.click(),
      openCamera: () => batchRef.current.openCamera(uploadTargetRef.current),
      openSheet: (files, target, capturedAtOverrides) =>
        batchRef.current.openSheet(files, target, capturedAtOverrides),
      openNewProject: () => setNewProjectOpen(true),
      openNewAlbum: () => setNewAlbumOpen(true),
      activeJobId,
      activeAlbumId,
      section,
      setQuery,
      setViewerOpen,
      setSelecting,
    }),
    [activeJobId, activeAlbumId, section, setQuery]
  );

  // Until the session check finishes (and in the prerendered HTML), draw the
  // frame with grey stand-ins, so a cold open paints something app-shaped at
  // once instead of "Verifying authentication". Only the page waits: its
  // queries need the session. The tab bar is real, so a tap works already.
  // Phone vs desktop comes from CSS here (useDesktop() is false until after
  // hydration, which would flash the phone frame on a desktop).
  if (!ready) {
    return (
      <PhotosShellContext.Provider value={value}>
        <div className="flex h-dvh flex-col bg-[#222222] text-white">
          <TopBarSkeleton />
          <div className="flex min-h-0 flex-1">
            <RailSkeleton />
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)]">
              <PageSkeleton />
            </div>
          </div>
          <div className="desktop:hidden">
            <BottomNav />
          </div>
        </div>
      </PhotosShellContext.Provider>
    );
  }

  const showAddButton =
    !isDesktop && !selecting && !deadJob && !NO_ADD_BUTTON.includes(pathname);

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
      {uploadSheetMounted && (
        <UploadSheet
          files={batch.pickedFiles}
          open={batch.sheetOpen}
          onOpenChange={batch.setSheetOpen}
          defaultTarget={batch.sheetTarget}
          capturedAtOverrides={batch.capturedAtOverrides}
          sidecars={batch.sidecars}
        />
      )}
      <MultiShotCamera
        open={batch.cameraOpen}
        onClose={batch.closeCamera}
        onDone={batch.handleShotsDone}
      />
      {newProjectMounted && (
        <NewProjectSheet
          open={newProjectOpen}
          onOpenChange={setNewProjectOpen}
          onDone={(job) => router.push(`/photos/${job.id}`)}
        />
      )}
      {newAlbumMounted && (
        <NewAlbumSheet
          open={newAlbumOpen}
          onOpenChange={setNewAlbumOpen}
          onCreated={(album) => router.push(`/photos/albums/${album.id}`)}
        />
      )}
    </PhotosShellContext.Provider>
  );
}
