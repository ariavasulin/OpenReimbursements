"use client";

import { useRef, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * "Are you sure?" before a delete. The red button runs `onConfirm`; the dialog
 * stays open (and cannot be dismissed) while `busy`, and the caller closes it.
 * Closing hands focus back to whatever opened it, when that is still on the
 * page, and the last title and body stay up through the closing animation.
 */
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /** What will happen, in plain words. */
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm(): void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const shown = useRef<{ title: string; children: ReactNode }>({ title, children });
  // Read on the render that opens it: by the time an effect runs, the dialog
  // (a child, whose effects run first) has already taken focus.
  if (open && !wasOpen.current && typeof document !== "undefined") {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;
  if (open) shown.current = { title, children };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent
        className="border-[#4e4e4e] bg-[#2e2e2e] text-white"
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words text-lg">{shown.current.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-base text-[#b4b4b4]">{shown.current.children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel
            disabled={busy}
            className="min-h-11 border-[#4e4e4e] bg-transparent text-base text-white hover:bg-[#3e3e3e] hover:text-white"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            className="min-h-11 bg-red-600 text-base text-white hover:bg-red-700"
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
