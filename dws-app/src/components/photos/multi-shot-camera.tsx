"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// iOS mechanics: getUserMedia requires a secure context (the deployed HTTPS
// URL — it silently fails on `next dev` over a LAN IP), the stream must start
// from a user gesture (opening this component IS the tap), and the <video>
// needs playsinline + muted or iOS hijacks it fullscreen.

export interface CameraShot {
  file: File;
  /**
   * Shutter time. Canvas JPEGs carry no EXIF, so the capture moment rides
   * along explicitly and the upload sheet passes it through as captured_at.
   * Absent for native-fallback files (their EXIF is read as usual).
   */
  capturedAt?: Date;
}

/**
 * True when the device exposes a camera — pages hide "Take Photos" without
 * one (a PC without a webcam only gets Upload).
 */
export function useHasCamera(): boolean {
  const [hasCamera, setHasCamera] = useState(false);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    if (!media.enumerateDevices) {
      setHasCamera(true);
      return;
    }
    let cancelled = false;
    media
      .enumerateDevices()
      .then((devices) => {
        if (!cancelled) {
          setHasCamera(devices.some((device) => device.kind === "videoinput"));
        }
      })
      // Enumeration can fail before any permission grant — getUserMedia
      // exists, so optimistically offer the camera and let it fall back.
      .catch(() => {
        if (!cancelled) setHasCamera(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return hasCamera;
}

interface Shot extends CameraShot {
  previewUrl: string;
}

interface MultiShotCameraProps {
  open: boolean;
  /** User backed out without finishing (X). */
  onClose(): void;
  /** Done (or the native fallback picked files) — the batch to upload. */
  onDone(shots: CameraShot[]): void;
}

export default function MultiShotCamera({
  open,
  onClose,
  onDone,
}: MultiShotCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const shotNumberRef = useRef(0);
  const [status, setStatus] = useState<"starting" | "live" | "denied">(
    "starting"
  );
  const [shots, setShots] = useState<Shot[]>([]);
  const [flash, setFlash] = useState(false);

  // Start the stream when the camera opens; stop every track on close (a
  // camera left running drains the battery and keeps the OS indicator on).
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    shotNumberRef.current = 0;
    setShots([]);
    setStatus("starting");

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera API unavailable");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {
            // Autoplay hiccups self-resolve once the muted stream attaches.
          });
        }
        if (!cancelled) setStatus("live");
      } catch {
        if (!cancelled) setStatus("denied");
      }
    };
    start();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      setShots((previous) => {
        for (const shot of previous) URL.revokeObjectURL(shot.previewUrl);
        return [];
      });
    };
  }, [open]);

  if (!open) return null;

  const takeShot = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    setFlash(true);
    setTimeout(() => setFlash(false), 120);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );
    if (!blob) return;

    const capturedAt = new Date();
    const shotNumber = ++shotNumberRef.current;
    // A real File, not a bare Blob — storage keys and download names need a
    // filename to exist.
    const file = new File(
      [blob],
      `IMG_${capturedAt.getTime()}_${shotNumber}.jpg`,
      { type: "image/jpeg", lastModified: capturedAt.getTime() }
    );
    setShots((previous) => [
      ...previous,
      { file, capturedAt, previewUrl: URL.createObjectURL(file) },
    ]);
  };

  const finish = () => {
    if (shots.length === 0) return;
    onDone(shots.map(({ file, capturedAt }) => ({ file, capturedAt })));
  };

  const handleFallbackFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) onDone(files.map((file) => ({ file })));
  };

  const lastShots = shots.slice(-3);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {status !== "denied" && (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
          />
          {flash && <div className="absolute inset-0 bg-white/70" />}
          {status === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[#a0a0a0]">
              Starting camera...
            </div>
          )}
        </>
      )}

      {status === "denied" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
          <p className="text-sm text-white">
            The in-app camera is not available — camera access was denied or is
            unsupported here.
          </p>
          <p className="text-xs text-[#a0a0a0]">
            You can still shoot with the device camera (one photo at a time).
          </p>
          <input
            ref={fallbackInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handleFallbackFiles}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => fallbackInputRef.current?.click()}
            className="rounded-lg bg-[#2680FC] px-6 py-3 text-sm font-medium text-white hover:bg-[#1a6fd8]"
          >
            Open device camera
          </button>
        </div>
      )}

      <div className="absolute left-0 right-0 top-0 flex items-center justify-between px-4 pb-4 pt-[max(14px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close camera"
          className="rounded-full bg-black/40 p-2 text-white/80 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>
        {shots.length > 0 && (
          <button
            type="button"
            onClick={finish}
            className="rounded-full bg-black/40 px-4 py-2 text-sm font-semibold text-[#2680FC]"
          >
            Done ({shots.length})
          </button>
        )}
      </div>

      {status === "live" && (
        <div className="absolute bottom-0 left-0 right-0 pb-[max(22px,env(safe-area-inset-bottom))]">
          {lastShots.length > 0 && (
            <div className="absolute bottom-[max(30px,env(safe-area-inset-bottom))] left-6 flex">
              {lastShots.map((shot, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={shot.file.name}
                  src={shot.previewUrl}
                  alt={`Shot ${shots.length - lastShots.length + index + 1}`}
                  className="-ml-3.5 h-11 w-11 rounded-lg border-2 border-[#222222] object-cover first:ml-0"
                />
              ))}
              <span className="absolute -right-3 -top-3 rounded-full bg-[#2680FC] px-2 py-0.5 text-[11px] font-bold text-white">
                {shots.length}
              </span>
            </div>
          )}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={takeShot}
              aria-label="Take photo"
              className="h-16 w-16 rounded-full border-4 border-white bg-white/25 active:bg-white/50"
            />
          </div>
        </div>
      )}
    </div>
  );
}
