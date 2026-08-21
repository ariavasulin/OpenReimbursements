"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import MultiShotCamera, {
  readPickedFiles,
  useHasCamera,
  type CameraShot,
} from "@/components/photos/multi-shot-camera";

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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(initialCameraOpen);

  const handleFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = readPickedFiles(event);
    if (files.length > 0) {
      setPickedFiles(files);
      setCapturedAtOverrides(new Map());
      setSheetOpen(true);
    }
  };

  const handleShotsDone = (shots: CameraShot[]) => {
    const overrides = new Map<File, Date>();
    for (const shot of shots) {
      if (shot.capturedAt) overrides.set(shot.file, shot.capturedAt);
    }
    setPickedFiles(shots.map((shot) => shot.file));
    setCapturedAtOverrides(overrides);
    setCameraOpen(false);
    setSheetOpen(true);
  };

  return {
    pickedFiles,
    capturedAtOverrides,
    sheetOpen,
    setSheetOpen,
    cameraOpen,
    setCameraOpen,
    handleFilesPicked,
    handleShotsDone,
  };
}

interface CaptureBarProps {
  batch: ReturnType<typeof useCaptureBatch>;
  /** Tailwind max-width class matching the page's <main>. */
  maxWidthClass: string;
}

/** Fixed bottom bar: Take Photos (when a camera exists) + Upload picker. */
export function CaptureBar({ batch, maxWidthClass }: CaptureBarProps) {
  const hasCamera = useHasCamera();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div
        className={`fixed bottom-4 left-0 right-0 mx-auto flex w-full ${maxWidthClass} gap-2 px-4`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={pickerAccept()}
          onChange={batch.handleFilesPicked}
          className="sr-only"
        />
        {hasCamera && (
          <Button
            size="lg"
            onClick={() => batch.setCameraOpen(true)}
            className="h-auto flex-1 rounded-lg bg-[#2680FC] py-3 text-white shadow-lg hover:bg-[#1a6fd8]"
          >
            Take Photos
          </Button>
        )}
        <Button
          size="lg"
          onClick={() => fileInputRef.current?.click()}
          className={`h-auto flex-1 rounded-lg py-3 text-white shadow-lg ${
            hasCamera
              ? "border border-[#4e4e4e] bg-[#2e2e2e] hover:border-[#2680FC] hover:bg-[#2e2e2e]"
              : "bg-[#2680FC] hover:bg-[#1a6fd8]"
          }`}
        >
          Upload
        </Button>
      </div>

      <MultiShotCamera
        open={batch.cameraOpen}
        onClose={() => batch.setCameraOpen(false)}
        onDone={batch.handleShotsDone}
      />
    </>
  );
}
