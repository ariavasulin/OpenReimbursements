"use client";

// What the selection bar and its pop-ups share: sending a change in slices
// under one progress toast, and saying how a failed one went.

import { toast } from "sonner";
import { MAX_BULK_PHOTOS } from "@/lib/photos/apiShared";
import { inChunks, PartialBulkError } from "@/lib/photos/chunks";
import { formatCount, plural } from "@/lib/photos/format";

/** A pop-up's main button. */
export const primaryButton =
  "h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]";

export const errorText = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

/**
 * Send a bulk change in slices the route accepts. Past one slice, one toast
 * counts up while it runs; the caller's outcome toast replaces it (`toastId`).
 * A failure part way says how far it got: the slices sent are saved, and the
 * same change again finishes the rest.
 */
export async function sendInSlices<T>(
  ids: string[],
  call: (chunk: string[]) => Promise<T>,
  progress: (done: number, total: number) => string
): Promise<{ results: T[]; toastId: string | number | undefined }> {
  const toastId = ids.length > MAX_BULK_PHOTOS ? toast.loading(progress(0, ids.length)) : undefined;
  try {
    const results = await inChunks(ids, call, (done, total) => {
      if (toastId !== undefined && done < total) toast.loading(progress(done, total), { id: toastId });
    });
    return { results, toastId };
  } catch (reason) {
    if (toastId !== undefined) toast.dismiss(toastId);
    throw reason;
  }
}

/** A failed bulk change in words; a partial one says how many were done. */
export const sliceError = (reason: unknown, fallback: string, done: (count: string) => string) =>
  reason instanceof PartialBulkError
    ? `${done(`${formatCount(reason.done)} of ${plural(reason.total, "photo")}`)}, then it stopped: ${reason.message.replace(/[.!?]?$/, ".")} Try again to finish.`
    : errorText(reason, fallback);

export interface BulkSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  photoIds: string[];
  /** The change is saved: refresh the grids and clear the selection. */
  onDone(): void;
}
