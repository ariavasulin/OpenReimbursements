"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  AuthLoading,
  PHOTOS_AUTH_LOADING_CLASS,
  useSessionGuard,
} from "@/hooks/use-session-guard";
import { useDesktop } from "@/hooks/use-desktop";
import { pickerAccept, useCaptureBatch } from "@/hooks/use-capture-batch";
import DropZone from "@/components/photos/drop-zone";
import JobsRail from "@/components/photos/jobs-rail";
import MultiShotCamera from "@/components/photos/multi-shot-camera";
import TopBar from "@/components/photos/top-bar";
import UploadSheet from "@/components/photos/upload-sheet";
import {
  PHOTOS_SCROLLPORT_ID,
  PhotosShellContext,
  type PhotosShellValue,
} from "@/components/photos/photos-shell-context";
import { fetchJobs } from "@/lib/photos/api";
import { jobLabel } from "@/lib/photos/format";

/**
 * The /photos frame: owns the session guard (hoisted out of the pages), the
 * scroll container, the one capture batch, and every upload-intake mount
 * (hidden picker input, DropZone, UploadSheet, MultiShotCamera) — so the
 * sheet outlives route changes and pages only render content.
 */
export default function PhotosShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ jobId?: string }>();

  const search = searchParams.toString();
  // Armed on the route only: the lightbox rewrites `?photo=` in place on every
  // slide, and re-arming there would re-check the session ~once per swipe.
  const ready = useSessionGuard(
    search ? `${pathname}?${search}` : pathname,
    pathname
  );
  const isDesktop = useDesktop();
  const activeJobId = params?.jobId ?? null;

  const batch = useCaptureBatch();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Only for the drop overlay's "Drop to upload to #NNNN · Name" label.
  // Deduped with the job page's identical query by react-query.
  const { data: jobsForLabel } = useQuery({
    queryKey: ["photo-jobs", ""],
    queryFn: () => fetchJobs(),
    enabled: ready && isDesktop && activeJobId !== null,
    staleTime: 60_000,
  });
  const activeJob = jobsForLabel?.find((job) => job.id === activeJobId);

  // Not memoized: batch.openSheet is a fresh closure every render, so any
  // memo over it would bust every render anyway.
  const value: PhotosShellValue = {
    openPicker: () => fileInputRef.current?.click(),
    openCamera: () => batch.openCamera(activeJobId ?? undefined),
    openSheet: batch.openSheet,
    activeJobId,
    query,
    setQuery,
    debouncedQuery,
    setViewerOpen,
  };

  if (!ready) {
    return <AuthLoading className={PHOTOS_AUTH_LOADING_CLASS} />;
  }

  return (
    <PhotosShellContext.Provider value={value}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={pickerAccept()}
        onChange={(event) =>
          batch.handleFilesPicked(event, activeJobId ?? undefined)
        }
        className="sr-only"
      />

      <div className="flex h-dvh flex-col bg-[#222222] text-white">
        {isDesktop && <TopBar />}
        <div className="flex min-h-0 flex-1">
          {isDesktop && <JobsRail />}
          {/* With viewport-fit=cover this runs under the notch and home
              indicator, so it pads by the safe-area insets. */}
          <div
            id={PHOTOS_SCROLLPORT_ID}
            // The desktop viewer lands focus here when the tile that opened
            // it no longer exists.
            tabIndex={-1}
            className="min-h-0 flex-1 focus:outline-none overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
          >
            {children}
          </div>
        </div>
      </div>

      {/* Pointer-only: a touch device would never fire its window listeners. */}
      {isDesktop && (
        <DropZone
          onFiles={(files) => batch.openSheet(files, activeJobId ?? undefined)}
          label={activeJob ? jobLabel(activeJob) : undefined}
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
        defaultJobId={batch.sheetJobId}
        capturedAtOverrides={batch.capturedAtOverrides}
        sidecars={batch.sidecars}
      />
      <MultiShotCamera
        open={batch.cameraOpen}
        onClose={batch.closeCamera}
        onDone={batch.handleShotsDone}
      />
    </PhotosShellContext.Provider>
  );
}
