"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, RotateCw, X } from "lucide-react";
import { useUploadManager } from "@/lib/photos/upload-manager";
import { pickerAccept } from "@/components/photos/capture-bar";
import { readPickedFiles } from "@/components/photos/multi-shot-camera";
import UploadProgress, { type UploadRow } from "@/components/photos/upload-progress";
import { plural } from "@/lib/photos/format";
import type { QueueItem } from "@/lib/photos/upload-queue";

// The always-visible upload status bar, pinned above the CaptureBar on every
// photos page.

function summary(items: QueueItem[], active: boolean): string {
  const count = (statuses: QueueItem["status"][]) =>
    items.filter((i) => statuses.includes(i.status)).length;
  if (active) {
    const settled = count(["done", "duplicate", "failed"]);
    return `Uploading ${Math.min(settled + 1, items.length)} of ${items.length}`;
  }
  const interrupted = count(["interrupted"]);
  if (interrupted) return `${plural(interrupted, "upload")} interrupted`;
  const failed = count(["failed"]);
  if (failed) return `${plural(failed, "upload")} failed`;
  // Duplicates are reported apart from uploads: "already in this job" is not
  // the same news as "uploaded".
  const uploaded = count(["done"]);
  const duplicates = count(["duplicate"]);
  if (!duplicates) return `${uploaded} uploaded`;
  if (!uploaded) return `${plural(duplicates, "photo")} already in this job`;
  return `${uploaded} uploaded, ${duplicates} already in this job`;
}

export default function UploadTray({
  maxWidthClass,
}: {
  /** Tailwind max-width class matching the page's <main>. */
  maxWidthClass: string;
}) {
  const manager = useUploadManager();
  const [expanded, setExpanded] = useState(false);
  const repickInputRef = useRef<HTMLInputElement>(null);

  if (manager.items.length === 0) return null;

  const { items, active } = manager;
  const settledOnly = items.every(
    (i) => i.status === "done" || i.status === "duplicate"
  );

  const handleRepicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = readPickedFiles(event);
    if (files.length === 0) return;
    const unmatched = manager.repick(files);
    for (const file of unmatched) {
      toast.error(`${file.name} wasn't in the interrupted list`);
    }
  };

  const rows: UploadRow[] = items.map((item) => {
    const primary =
      item.status === "failed" ? (
        <RowButton onClick={() => manager.retry(item.photoId)}>
          <RotateCw className="h-3 w-3" />
          Retry
        </RowButton>
      ) : item.status === "interrupted" ? (
        <RowButton onClick={() => repickInputRef.current?.click()}>
          Re-pick
        </RowButton>
      ) : null;
    return {
      item,
      actions: primary ? (
        <>
          {primary}
          <RemoveButton
            onClick={() => manager.remove(item.photoId)}
            name={item.name}
          />
        </>
      ) : undefined,
    };
  });

  return (
    <div
      className={`fixed bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))] left-0 right-0 z-40 mx-auto w-full ${maxWidthClass} px-4`}
    >
      <input
        ref={repickInputRef}
        type="file"
        multiple
        accept={pickerAccept()}
        onChange={handleRepicked}
        className="sr-only"
      />
      <div className="overflow-hidden rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] shadow-lg">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
          >
            <span className="truncate text-[13px] font-semibold text-white">
              {summary(items, active)}
            </span>
            {expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-[#a0a0a0]" />
            ) : (
              <ChevronUp className="h-4 w-4 shrink-0 text-[#a0a0a0]" />
            )}
          </button>
          {settledOnly && (
            <button
              type="button"
              onClick={() => manager.dismissDone()}
              className="shrink-0 px-3 py-2.5 text-[13px] text-[#a0a0a0] hover:text-white"
            >
              Dismiss
            </button>
          )}
        </div>
        {expanded && (
          <div className="px-3 pt-1 [&>div]:mb-2">
            <UploadProgress rows={rows} />
          </div>
        )}
      </div>
    </div>
  );
}

function RowButton({
  onClick,
  children,
}: {
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-md bg-[#2680FC] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1a6fd8]"
    >
      {children}
    </button>
  );
}

function RemoveButton({ onClick, name }: { onClick(): void; name: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove ${name}`}
      className="flex h-6 w-6 items-center justify-center rounded-md border border-[#4e4e4e] text-[#a0a0a0] hover:bg-red-500 hover:text-white"
    >
      <X className="h-3 w-3" />
    </button>
  );
}
