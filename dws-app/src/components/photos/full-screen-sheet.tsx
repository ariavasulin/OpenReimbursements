"use client";

import type { KeyboardEvent, ReactNode, TouchEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

// Full-screen step nested inside a SheetShell (project picker, batch preview).
// A separate Radix Dialog at z-[60] so it stacks above the sheet (Drawer or
// Dialog) without the outer layer treating taps here as "outside" clicks;
// data-vaul-no-drag keeps swipes inside it from dragging the drawer.

interface FullScreenSheetProps {
  open: boolean;
  onClose(): void;
  /** Accessible name; rendered visually hidden. */
  title: string;
  /** Background for both the overlay and the content. */
  className?: string;
  onOpenAutoFocus?(event: Event): void;
  onCloseAutoFocus?(event: Event): void;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  onTouchStart?(event: TouchEvent<HTMLDivElement>): void;
  onTouchEnd?(event: TouchEvent<HTMLDivElement>): void;
  children: ReactNode;
}

export default function FullScreenSheet({
  open,
  onClose,
  title,
  className = "bg-[#222222]",
  onOpenAutoFocus,
  onCloseAutoFocus,
  onKeyDown,
  onTouchStart,
  onTouchEnd,
  children,
}: FullScreenSheetProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn("fixed inset-0 z-[60]", className)} />
        <DialogPrimitive.Content
          data-vaul-no-drag
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onKeyDown={onKeyDown}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className={cn(
            "fixed inset-0 z-[60] flex flex-col text-white focus:outline-none",
            className
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The way out of a full-screen step: always a visible word, never an icon
 * alone, and a full 44px target — its hosts put it first in their header.
 */
export function FullScreenSheetLeave({
  label,
  onClick,
}: {
  /** "Back" for a step inside a pop-up, "Close" for a viewer. */
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-base font-medium text-[#8bbaff] hover:bg-white/10"
    >
      {label === "Back" && <span aria-hidden="true">&lsaquo;</span>}
      {label}
    </button>
  );
}
