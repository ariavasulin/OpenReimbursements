"use client";

import { Button } from "@/components/ui/button";
import { useHasCamera } from "@/components/photos/multi-shot-camera";
import { usePhotosShell } from "@/components/photos/photos-shell-context";

interface CaptureBarProps {
  /** Tailwind max-width class matching the page's <main>. */
  maxWidthClass: string;
}

/**
 * Fixed bottom bar: Take Photos (when a camera exists) + Upload picker. The
 * PhotosShell owns the picker input, the camera, and the sheet; this bar is
 * just the phone-width entry point, hidden at desktop.
 */
export function CaptureBar({ maxWidthClass }: CaptureBarProps) {
  const hasCamera = useHasCamera();
  const { openPicker, openCamera } = usePhotosShell();

  return (
    <div
      className={`desktop:hidden fixed bottom-[calc(1rem_+_env(safe-area-inset-bottom))] left-0 right-0 mx-auto flex w-full ${maxWidthClass} gap-2 px-4`}
    >
      {hasCamera && (
        <Button
          size="lg"
          onClick={openCamera}
          className="h-auto flex-1 rounded-lg bg-[#2680FC] py-3 text-white shadow-lg hover:bg-[#1a6fd8]"
        >
          Take Photos
        </Button>
      )}
      <Button
        size="lg"
        onClick={openPicker}
        className={`h-auto flex-1 rounded-lg py-3 text-white shadow-lg ${
          hasCamera
            ? "border border-[#4e4e4e] bg-[#2e2e2e] hover:border-[#2680FC] hover:bg-[#2e2e2e]"
            : "bg-[#2680FC] hover:bg-[#1a6fd8]"
        }`}
      >
        Upload
      </Button>
    </div>
  );
}
