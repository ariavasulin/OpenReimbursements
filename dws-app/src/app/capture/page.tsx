"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import MultiShotCamera, {
  type CameraShot,
} from "@/components/photos/multi-shot-camera";
import UploadSheet from "@/components/photos/upload-sheet";

// Instant capture: the deep link an iPhone Back Tap / Action Button shortcut
// opens. Lands straight in the multi-shot camera (session guard first — the
// login page honors ?next= so the deep link survives the round-trip). Done
// hands the batch to the standard upload sheet; the job is picked there.

export default function CapturePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [capturedAtOverrides, setCapturedAtOverrides] = useState<
    Map<File, Date>
  >(new Map());
  const [sheetOpen, setSheetOpen] = useState(false);
  const uploadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const guard = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mountedRef.current) return;
      if (!session) {
        window.location.replace("/login?next=/capture");
        return;
      }
      setReady(true);
    };
    guard();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          window.location.replace("/login?next=/capture");
        }
      }
    );
    return () => {
      mountedRef.current = false;
      authListener?.subscription?.unsubscribe();
    };
  }, []);

  const handleShotsDone = (shots: CameraShot[]) => {
    const overrides = new Map<File, Date>();
    for (const shot of shots) {
      if (shot.capturedAt) overrides.set(shot.file, shot.capturedAt);
    }
    setFiles(shots.map((shot) => shot.file));
    setCapturedAtOverrides(overrides);
    setCameraOpen(false);
    setSheetOpen(true);
  };

  const handleSheetChange = (open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      if (uploadedRef.current) {
        // Batch landed — the natural next stop is the photos home.
        router.replace("/photos");
      } else {
        // Cancelled without uploading — back to shooting.
        setCameraOpen(true);
      }
    }
  };

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#222222] px-4 py-8 text-white">
        <div className="text-center">
          <p className="mb-2 text-lg">Loading...</p>
          <p className="text-sm text-gray-400">Verifying authentication</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#222222] text-white">
      <MultiShotCamera
        open={cameraOpen}
        onClose={() => router.replace("/photos")}
        onDone={handleShotsDone}
      />

      <UploadSheet
        files={files}
        open={sheetOpen}
        onOpenChange={handleSheetChange}
        onUploaded={() => {
          uploadedRef.current = true;
        }}
        capturedAtOverrides={capturedAtOverrides}
      />
    </div>
  );
}
