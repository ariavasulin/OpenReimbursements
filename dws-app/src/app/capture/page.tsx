"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Toaster as SonnerToaster } from "sonner";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import MultiShotCamera from "@/components/photos/multi-shot-camera";
import { useCaptureBatch } from "@/components/photos/capture-bar";
import UploadSheet from "@/components/photos/upload-sheet";
import UploadTray from "@/components/photos/upload-tray";
import { UploadManagerProvider } from "@/lib/photos/upload-manager";

// Instant capture: the deep link an iPhone Back Tap / Action Button shortcut
// opens. Lands straight in the multi-shot camera (session guard first — the
// login page honors ?next= so the deep link survives the round-trip). Done
// hands the batch to the standard upload sheet; the job is picked there.

export default function CapturePage() {
  const router = useRouter();
  const ready = useSessionGuard("/capture");
  const batch = useCaptureBatch(true);
  const uploadedRef = useRef(false);

  const handleSheetChange = (open: boolean) => {
    batch.setSheetOpen(open);
    if (!open) {
      if (uploadedRef.current) router.replace("/photos");
      else batch.setCameraOpen(true);
    }
  };

  if (!ready) {
    return (
      <AuthLoading className="flex min-h-dvh items-center justify-center bg-[#222222] px-4 py-8 text-white" />
    );
  }

  return (
    // This page lives outside /photos, so it mounts its own manager: uploads
    // enqueued here keep running while the camera stays open. Navigating away
    // interrupts them (manifest + re-pick recovers, like any reload).
    <UploadManagerProvider>
      <div className="min-h-dvh bg-[#222222] text-white">
        <MultiShotCamera
          open={batch.cameraOpen}
          onClose={() => router.replace("/photos")}
          onDone={batch.handleShotsDone}
        />

        <UploadSheet
          files={batch.pickedFiles}
          open={batch.sheetOpen}
          onOpenChange={handleSheetChange}
          onUploaded={() => {
            uploadedRef.current = true;
          }}
          capturedAtOverrides={batch.capturedAtOverrides}
        />

        <UploadTray maxWidthClass="max-w-2xl" />
        <SonnerToaster richColors theme="dark" />
      </div>
    </UploadManagerProvider>
  );
}
