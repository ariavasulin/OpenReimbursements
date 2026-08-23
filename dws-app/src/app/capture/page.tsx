"use client";

import { useRouter } from "next/navigation";
import { AuthLoading, useSessionGuard } from "@/hooks/use-session-guard";
import MultiShotCamera from "@/components/photos/multi-shot-camera";
import { useCaptureBatch } from "@/components/photos/capture-bar";
import UploadSheet from "@/components/photos/upload-sheet";
import UploadShell from "@/components/photos/upload-shell";

// Instant capture: the deep link an iPhone Back Tap / Action Button shortcut
// opens. Lands straight in the multi-shot camera (session guard first — the
// login page honors ?next= so the deep link survives the round-trip). Done
// hands the batch to the standard upload sheet; the job is picked there.

export default function CapturePage() {
  const router = useRouter();
  const ready = useSessionGuard("/capture");
  const batch = useCaptureBatch(true);

  // Closing the sheet (upload handed off or cancelled) returns to the camera;
  // the tray shows upload progress over it.
  const handleSheetChange = (open: boolean) => {
    batch.setSheetOpen(open);
    if (!open) batch.setCameraOpen(true);
  };

  if (!ready) {
    return (
      <AuthLoading className="flex min-h-dvh items-center justify-center bg-[#222222] px-4 py-8 text-white" />
    );
  }

  return (
    // This page lives outside /photos, so it mounts its own shell: uploads
    // enqueued here keep running while the camera stays open. Navigating away
    // interrupts them (manifest + re-pick recovers, like any reload).
    <UploadShell>
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
          capturedAtOverrides={batch.capturedAtOverrides}
          sidecars={batch.sidecars}
        />
      </div>
    </UploadShell>
  );
}
