"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronUp, RotateCw, X } from "lucide-react";
import { useUploadManager } from "@/lib/photos/upload-manager";
import { pickerAccept, readInputFiles } from "@/lib/photos/batch";
import UploadProgress, { type UploadRow } from "@/components/photos/upload-progress";
import { plural } from "@/lib/photos/format";
import { photoPath } from "@/lib/photos/photo-link";
import type { QueueItem } from "@/lib/photos/upload-queue";

// The always-visible upload status bar, pinned above the CaptureBar on every
// photos page.

function summary(items: QueueItem[], active: boolean): string {
  const count = (statuses: QueueItem["status"][]) =>
    items.filter((i) => statuses.includes(i.status)).length;
  if (count(["cancelling"])) return "Removing upload...";
  if (count(["cancel_pending"])) return `${plural(count(["cancel_pending"]), "removal")} pending`;
  if (active) {
    const settled = count(["done", "duplicate", "failed", "job_conflict", "restore_required", "waiting_claim"]);
    return `Uploading ${Math.min(settled + 1, items.length)} of ${items.length}`;
  }
  const interrupted = count(["interrupted"]);
  if (interrupted) return `${plural(interrupted, "upload")} interrupted`;
  const unresolved = count(["job_conflict", "restore_required", "waiting_claim"]);
  if (unresolved) return `${plural(unresolved, "upload")} needs attention`;
  const failed = count(["failed"]);
  if (failed) return `${plural(failed, "upload")} failed`;
  const sidecars = items.filter((i) => i.sidecarRetry).length;
  if (sidecars) return `${plural(sidecars, "photo")} uploaded — XMP needs attention`;
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
  const pathname = usePathname();
  useEffect(() => setExpanded(false), [pathname]);
  const repickInputRef = useRef<HTMLInputElement>(null);
  const sidecarInputRef = useRef<HTMLInputElement>(null);
  const sidecarTarget = useRef<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const current = Date.now();
    const due = manager.items.reduce((earliest, item) =>
      item.retryAt && item.retryAt > current ? Math.min(earliest, item.retryAt) : earliest, Infinity);
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1, due - current)));
    return () => clearTimeout(timer);
  }, [manager.items, now]);

  if (manager.items.length === 0) return null;

  const { items, active } = manager;
  const settledOnly = items.every(
    (i) => (i.status === "done" && !i.sidecarRetry) || i.status === "duplicate"
  );

  const handleRepicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = readInputFiles(event.target);
    if (files.length === 0) return;
    const unmatched = manager.repick(files);
    for (const file of unmatched) {
      toast.error(`${file.name} wasn't in the interrupted list`);
    }
  };

  const rows: UploadRow[] = items.map((item) => {
    const retryDeferred = (item.retryAt ?? 0) > Date.now();
    let primary: ReactNode = null;
    if (item.status === "cancel_pending") {
      primary = (
        <RowButton onClick={() => manager.remove(item.photoId)}>Retry removal</RowButton>
      );
    } else if (item.status === "done" && item.sidecarRetry) {
      primary = (
        <RowButton disabled={retryDeferred} onClick={() => {
          sidecarTarget.current = item.photoId;
          sidecarInputRef.current?.click();
        }}>
          {retryDeferred ? "Retry later" : "Re-pick XMP"}
        </RowButton>
      );
    } else if (["failed", "job_conflict", "restore_required", "waiting_claim"].includes(item.status)) {
      primary = (
        <RowButton disabled={retryDeferred} onClick={() => manager.retry(item.photoId)}>
          <RotateCw className="h-3 w-3" />
          {retryDeferred ? "Retry later" : item.status === "failed" ? "Retry" : "Check again"}
        </RowButton>
      );
    } else if (item.status === "interrupted") {
      primary = (
        <RowButton onClick={() => repickInputRef.current?.click()}>
          Re-pick
        </RowButton>
      );
    }
    return {
      item,
      actions: primary ? (
        <>
          {primary}
          {item.canonicalPhotoId && item.status !== "restore_required" && (
            <Link
              href={photoPath(item.canonicalJobId ?? null, item.canonicalPhotoId)}
              className="rounded-md px-2 py-1.5 text-[11px] text-[#8bbaff] underline"
            >
              View photo
            </Link>
          )}
          {item.canonicalPhotoId && ["job_conflict", "restore_required"].includes(item.status) && (
            <Link
              href={`/photos/actions?${new URLSearchParams({ action: item.status === "job_conflict" ? "move" : "restore", photo: item.canonicalPhotoId, destination: item.jobId })}`}
              className="rounded-md px-2 py-1.5 text-[11px] text-[#8bbaff] underline"
            >
              {item.status === "job_conflict" ? "Review move" : "Review restore"}
            </Link>
          )}
          {["job_conflict", "restore_required"].includes(item.status) && <span className="basis-full text-xs text-[#bbb]">After the action, choose Check again. No second copy is uploaded.</span>}
          {item.status !== "cancel_pending" && <RemoveButton
            onClick={() => manager.remove(item.photoId)}
            name={item.name}
          />}
        </>
      ) : item.status === "queued" || item.status === "uploading" ? (
        <RemoveButton onClick={() => manager.remove(item.photoId)} name={item.name} />
      ) : undefined,
    };
  });

  return (
    <div
      // 4.5rem clears the phone CaptureBar; at desktop that bar is hidden.
      className={`fixed bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))] left-0 right-0 z-40 mx-auto w-full ${maxWidthClass} px-4 desktop:bottom-4`}
    >
      <input
        ref={sidecarInputRef}
        type="file"
        accept=".xmp,application/rdf+xml"
        className="sr-only"
        onChange={(event) => {
          const file = readInputFiles(event.target)[0];
          const id = sidecarTarget.current;
          if (file && id) manager.retrySidecar(id, file);
        }}
      />
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
  disabled = false,
}: {
  onClick(): void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded-md bg-[#2680FC] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1a6fd8] disabled:opacity-50"
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
