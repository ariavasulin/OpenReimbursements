"use client";

import { useState } from "react";
import { toast } from "sonner";
import { readInputFiles } from "@/lib/photos/batch";
import { pairByBasename } from "@/lib/photos/sidecar";
import type { CameraShot } from "@/components/photos/multi-shot-camera";

/**
 * File-picker accept attribute: generic `image/*,video/*` on iOS ONLY —
 * explicitly listing image/heic defeats Safari's automatic HEIC→JPEG
 * conversion. Everywhere else the picker stays unrestricted so companion
 * files (XMP sidecars, RAW) remain pickable.
 */
export function pickerAccept(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    ? "image/*,video/*"
    : undefined;
}

// The shared "get files into a batch" state: the native picker and the in-app
// multi-shot camera both end with pickedFiles + capturedAtOverrides and the
// upload sheet open.
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
   * The job the sheet was opened for, snapshotted at open. Navigating while
   * the sheet is up must never re-derive its job.
   */
  const [sheetJobId, setSheetJobId] = useState<string | undefined>(undefined);
  /**
   * Same snapshot for the camera, taken when it opens: the shell outlives
   * route changes, so shooting on job A and navigating to job B before Done
   * would otherwise file the batch to B.
   */
  const [cameraJobId, setCameraJobId] = useState<string | undefined>(undefined);

  /** The one way a batch starts: picker, camera, and drop all land here. */
  const openSheet = (
    files: File[],
    jobId?: string,
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
    setSheetJobId(jobId);
    setSheetOpen(true);
  };

  const handleFilesPicked = (
    event: React.ChangeEvent<HTMLInputElement>,
    jobId?: string
  ) => {
    openSheet(readInputFiles(event.target), jobId);
  };

  /** Opens the camera *and* snapshots its job — openSheet's counterpart. */
  const openCamera = (jobId?: string) => {
    setCameraJobId(jobId);
    setCameraOpen(true);
  };

  const closeCamera = () => setCameraOpen(false);

  const handleShotsDone = (shots: CameraShot[]) => {
    const overrides = new Map<File, Date>();
    for (const shot of shots) {
      if (shot.capturedAt) overrides.set(shot.file, shot.capturedAt);
    }
    setCameraOpen(false);
    openSheet(shots.map((shot) => shot.file), cameraJobId, overrides);
  };

  return {
    pickedFiles,
    capturedAtOverrides,
    sidecars,
    sheetOpen,
    setSheetOpen,
    sheetJobId,
    cameraOpen,
    // Only openCamera opens it: a raw setter would let a caller skip the job
    // snapshot the batch is filed under.
    openCamera,
    closeCamera,
    openSheet,
    handleFilesPicked,
    handleShotsDone,
  };
}
