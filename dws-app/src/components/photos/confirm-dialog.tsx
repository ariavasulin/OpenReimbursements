"use client";

import type { ReactNode } from "react";
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
  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="border-[#4e4e4e] bg-[#2e2e2e] text-white">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words text-lg">{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-base text-[#b4b4b4]">{children}</div>
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
