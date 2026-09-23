"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2, X } from "lucide-react";
import { PHOTOS_FLOATING_SLOT_ID, usePhotosShell } from "@/components/photos/photos-shell-context";

const actionClass =
  "flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50";

/**
 * The bar under a list of albums or projects in select mode, styled like the
 * photo selection bar: the count, Rename (exactly one selected), and Delete.
 */
export default function CollectionSelectBar({
  label,
  count,
  busy,
  onRename,
  onDelete,
  onClose,
}: {
  /** "Selected albums" / "Selected projects", for screen readers. */
  label: string;
  count: number;
  busy: boolean;
  onRename(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const { setSelecting } = usePhotosShell();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(PHOTOS_FLOATING_SLOT_ID)), []);
  // The shell hides its "+" button while this bar is up.
  useEffect(() => {
    setSelecting(true);
    return () => setSelecting(false);
  }, [setSelecting]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      // A sheet or dialog on top owns Escape: closing it must keep the selection.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  if (!slot) return null;
  return createPortal(
    <div
      role="region"
      aria-label={label}
      className="pointer-events-auto mx-auto w-full max-w-3xl rounded-xl border border-[#2680FC]/60 bg-[#1f2c40] shadow-xl shadow-black/50"
    >
      <div className="flex flex-wrap items-center gap-x-1 px-1.5 py-1">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Stop selecting"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <span aria-live="polite" className="mr-auto pr-2 text-base font-semibold text-white">
          {count === 0 ? "Choose items" : `${count} selected`}
        </span>
        <button type="button" className={actionClass} disabled={busy || count !== 1} onClick={onRename}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Rename
        </button>
        <button type="button" className={`${actionClass} text-red-200`} disabled={busy || count === 0} onClick={onDelete}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete
        </button>
      </div>
    </div>,
    slot
  );
}
