"use client";

import { useState } from "react";
import { toast } from "sonner";
import { pairByBasename } from "@/lib/photos/sidecar";
import type { CameraShot } from "@/components/photos/multi-shot-camera";
import type { PhotoAlbumRef } from "@/lib/photos/types";

/**
 * Where the page a batch started on would put it: the project page's project,
 * the album page's album, neither on Photos. It only pre-fills the upload
 * pop-up; the person can change both there.
 */
export interface UploadTarget {
  jobId?: string;
  album?: PhotoAlbumRef;
}

// The shared "get files into a batch" state: every intake ends with
// pickedFiles + capturedAtOverrides and the upload sheet open.
export function useCaptureBatch(initialCameraOpen = false) {
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  /** Shutter times for in-app camera shots (see CameraShot). */
  const [capturedAtOverrides, setCapturedAtOverrides] = useState<
    Map<File, Date>
  >(new Map());
  /** Paired .xmp per primary image (see pairByBasename). */
  const [sidecars, setSidecars] = useState<Map<File, File>>(new Map());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(initialCameraOpen);
  /**
   * The project or album the sheet was opened for, snapshotted at open.
   * Navigating while the sheet is up must never re-derive it.
   */
  const [sheetTarget, setSheetTarget] = useState<UploadTarget | undefined>(undefined);
  /**
   * Same snapshot for the camera, taken when it opens: the shell outlives
   * route changes, so shooting on job A and navigating to job B before Done
   * would otherwise file the batch to B.
   */
  const [cameraTarget, setCameraTarget] = useState<UploadTarget | undefined>(undefined);

  /** The one way a batch starts: picker, camera, and drop all land here. */
  const openSheet = (
    files: File[],
    target?: UploadTarget,
    overrides: Map<File, Date> = new Map()
  ) => {
    if (files.length === 0) return;
    // Pair .xmp sidecars with their image up front: the batch (and the
    // sheet's strip) carries primaries only; a lone .xmp never uploads.
    const { pairs, rejected } = pairByBasename(files);
    for (const r of rejected) toast.error(`${r.name} ${r.reason}`);
    if (pairs.length === 0) return;
    setPickedFiles(pairs.map((pair) => pair.primary.file));
    setSidecars(
      new Map(
        pairs.flatMap((pair) =>
          pair.sidecar ? [[pair.primary.file, pair.sidecar.file] as const] : []
        )
      )
    );
    setCapturedAtOverrides(overrides);
    setSheetTarget(target);
    setSheetOpen(true);
  };

  const openCamera = (target?: UploadTarget) => {
    setCameraTarget(target);
    setCameraOpen(true);
  };

  const closeCamera = () => setCameraOpen(false);

  const handleShotsDone = (shots: CameraShot[]) => {
    const overrides = new Map<File, Date>();
    for (const shot of shots) {
      if (shot.capturedAt) overrides.set(shot.file, shot.capturedAt);
    }
    setCameraOpen(false);
    openSheet(shots.map((shot) => shot.file), cameraTarget, overrides);
  };

  return {
    pickedFiles,
    capturedAtOverrides,
    sidecars,
    sheetOpen,
    setSheetOpen,
    sheetTarget,
    cameraOpen,
    openCamera,
    closeCamera,
    openSheet,
    handleShotsDone,
  };
}
