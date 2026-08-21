"use client";

import { useRef, useState } from "react";
import MultiShotCamera, {
  useHasCamera,
  type CameraShot,
} from "@/components/photos/multi-shot-camera";
import { pickerAccept } from "@/components/photos/upload-sheet";

// The shared "get files into a batch" state: the native picker and the in-app
// multi-shot camera both end with pickedFiles + capturedAtOverrides and the
// upload sheet open.
export function useCaptureBatch() {
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [capturedAtOverrides, setCapturedAtOverrides] = useState<
    Map<File, Date>
  >(new Map());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const handleFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-picking the same files
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
  inputId: string;
}

/** Fixed bottom bar: Take Photos (when a camera exists) + Upload picker. */
export function CaptureBar({ batch, maxWidthClass, inputId }: CaptureBarProps) {
  const hasCamera = useHasCamera();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div
        className={`fixed bottom-4 left-0 right-0 mx-auto flex w-full ${maxWidthClass} gap-2 px-4`}
      >
        <input
          ref={fileInputRef}
          id={inputId}
          type="file"
          multiple
          accept={pickerAccept()}
          onChange={batch.handleFilesPicked}
          className="sr-only"
        />
        {hasCamera && (
          <button
            type="button"
            onClick={() => batch.setCameraOpen(true)}
            className="flex-1 rounded-lg bg-[#2680FC] py-3 text-sm font-medium text-white shadow-lg hover:bg-[#1a6fd8]"
          >
            Take Photos
          </button>
        )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`flex-1 rounded-lg py-3 text-sm font-medium text-white shadow-lg ${
            hasCamera
              ? "border border-[#4e4e4e] bg-[#2e2e2e] hover:border-[#2680FC]"
              : "bg-[#2680FC] hover:bg-[#1a6fd8]"
          }`}
        >
          Upload
        </button>
      </div>

      <MultiShotCamera
        open={batch.cameraOpen}
        onClose={() => batch.setCameraOpen(false)}
        onDone={batch.handleShotsDone}
      />
    </>
  );
}
