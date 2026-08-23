"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface DropZoneProps {
  /** Called with the dropped files; the page hands them to the batch sheet. */
  onFiles(files: File[]): void;
  /** Job shown in the overlay, e.g. "#3962 · Westbridge". Omitted on /photos. */
  label?: string;
  /** False while a sheet or the camera is already up — a drop then would
   *  silently replace the batch the user is composing. */
  enabled?: boolean;
  /** Toast shown when a drop lands while `enabled` is false. */
  disabledReason?: string;
}

// types is already a frozen string[]; a dragover fires continuously, so this
// must not allocate.
const carriesFiles = (event: DragEvent) =>
  event.dataTransfer?.types.includes("Files") ?? false;

const DEFAULT_DISABLED_REASON =
  "Finish the upload you're composing before dropping more files.";

export default function DropZone({
  onFiles,
  label,
  enabled = true,
  disabledReason = DEFAULT_DISABLED_REASON,
}: DropZoneProps) {
  const [active, setActive] = useState(false);
  // dragleave fires on every child boundary crossing; count enters and leaves.
  const depth = useRef(0);
  // Keep the latest props without re-subscribing the listeners each render.
  // `enabled` in particular must NOT gate registration: with no listener
  // nothing calls preventDefault() and the browser navigates the tab to the
  // dropped file, taking the batch being composed with it.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const disabledReasonRef = useRef(disabledReason);
  disabledReasonRef.current = disabledReason;

  // Stable across renders (depth is a ref, setActive is a setter), so the
  // listener effect can depend on it without re-subscribing.
  const reset = useCallback(() => {
    depth.current = 0;
    setActive(false);
  }, []);

  // Intake went busy mid-drag: drop the overlay, keep the listeners.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(() => {
    const handleEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      if (enabledRef.current) setActive(true);
    };
    const handleOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser opens the file instead of dropping it.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = enabledRef.current ? "copy" : "none";
      }
    };
    const handleLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const handleDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Always: a swallowed drop must still not navigate the tab.
      event.preventDefault();
      reset();
      if (!enabledRef.current) {
        toast.error(disabledReasonRef.current, { id: "drop-zone-busy" });
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };

    window.addEventListener("dragenter", handleEnter);
    window.addEventListener("dragover", handleOver);
    window.addEventListener("dragleave", handleLeave);
    window.addEventListener("drop", handleDrop);
    // dragleave is not reliably balanced across engines, so a cancelled OS
    // drag (Esc, or a drop outside the window) can strand the overlay.
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", handleEnter);
      window.removeEventListener("dragover", handleOver);
      window.removeEventListener("dragleave", handleLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, [reset]);

  const message = `Drop to upload${label ? ` to ${label}` : ""}`;

  return (
    <>
      {/* Always mounted: a live region inserted at the same time as its text
          is not reliably announced. */}
      <p aria-live="polite" className="sr-only">
        {active ? message : ""}
      </p>
      {active && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[#222222]/85 p-8"
        >
          <div className="rounded-xl border-2 border-dashed border-[#2680FC] px-10 py-8 text-center">
            <p className="text-lg font-semibold text-white">{message}</p>
            <p className="mt-1 text-sm text-[#a0a0a0]">
              Photos, videos, and companion files
            </p>
          </div>
        </div>
      )}
    </>
  );
}
