"use client";

import { memo, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import { useMobile } from "@/hooks/use-mobile";
import { fetchJson } from "@/lib/photos/api";
import { formatCount, plural } from "@/lib/photos/format";
import {
  findRows,
  formatDownloadSize,
  isLargeDownload,
  selectionBytes,
  zipFileName,
  type ZipRow,
} from "@/lib/photos/zip-download";
import { openZipTarget, saveZip, ZipEmptyError, zipBuildsInMemory, type ZipTarget } from "@/lib/photos/zip-save";
import { errorText, primaryButton } from "./bulk-feedback";

// The selection bar's "Download": confirm the count and size, then save every
// selected original as one zip (lib/photos/zip-download.ts, zip-save.ts).
// Loaded on demand by the bar, so the zip code is not in the grid's first load.

/** Up to ten names, then "and N more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 10).join(", ");
  return names.length > 10 ? `${shown}, and ${formatCount(names.length - 10)} more` : shown;
}

/** POST /api/photos/rows for Download: the zip fields of up to 500 selected photos the grid has not loaded. */
async function lookupZipRows(ids: string[], signal?: AbortSignal): Promise<ZipRow[]> {
  const answer = await fetchJson<{ photos: ZipRow[] }>("/api/photos/rows", "Could not look up the photos", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: ids }),
    signal,
  });
  return answer.photos;
}

/**
 * Fetch and save the zip under one toast that counts up, then says how it went.
 * A zip missing any photo is reported as an error naming them, never as done.
 */
async function runDownload(rows: ZipRow[], target: ZipTarget) {
  const total = rows.length;
  const counting = (done: number) => `Downloading ${plural(total, "photo")}… ${formatCount(done)} done`;
  const toastId = toast.loading(counting(0), { description: "Keep this page open until the zip is saved." });
  // Leaving the page would lose the zip; the browser asks first.
  const stay = (event: BeforeUnloadEvent) => event.preventDefault();
  window.addEventListener("beforeunload", stay);
  const keep = { duration: Infinity, action: { label: "OK", onClick: () => {} } };
  try {
    const { failed } = await saveZip(rows, target, ({ done }) => {
      if (done < total) toast.loading(counting(done), { id: toastId });
    });
    if (failed.length === 0) {
      toast.success(`Downloaded ${plural(total, "photo")}`, { id: toastId, description: "Saved as one zip file." });
    } else {
      toast.error(`The zip is missing ${formatCount(failed.length)} of ${plural(total, "photo")}`, {
        id: toastId,
        description: `These could not be downloaded: ${nameList(failed)}. Select them and try again.`,
        ...keep,
      });
    }
  } catch (reason) {
    toast.error(reason instanceof ZipEmptyError ? "None of the photos could be downloaded" : "The download stopped", {
      id: toastId,
      description:
        reason instanceof ZipEmptyError
          ? `Could not download: ${nameList(reason.failed)}. No zip was saved.`
          : `${errorText(reason, "Something went wrong.")} The zip was not finished. Try again.`,
      ...keep,
    });
  } finally {
    window.removeEventListener("beforeunload", stay);
  }
}

type DownloadPlan =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: ZipRow[]; missing: number; bytes: number; unknown: number };

function DownloadSheet({
  open,
  onOpenChange,
  photoIds,
  loaded,
  albumName,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  photoIds: string[];
  loaded: readonly ZipRow[];
  albumName?: string;
  /** The download is under way (its toast reports it): the selection can go. */
  onStarted(): void;
}) {
  const isPhone = useMobile();
  const [plan, setPlan] = useState<DownloadPlan>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);

  // Closing forgets the last answer, so reopening never shows a stale total.
  useEffect(() => {
    if (open) setStarting(false);
    else setPlan({ state: "loading" });
  }, [open]);

  // Sizes and names for every selected photo, including ones not loaded yet.
  // Looked up again only if the selection grows while the sheet is open (a
  // group tick's answer arriving late).
  const wanted = photoIds.length;
  useEffect(() => {
    if (!open || wanted === 0) return;
    // Closing the sheet (or the selection changing) stops lookups still running.
    const controller = new AbortController();
    setPlan({ state: "loading" });
    findRows(photoIds, loaded, lookupZipRows, controller.signal)
      .then(({ rows, missing }) => {
        if (!controller.signal.aborted) setPlan({ state: "ready", rows, missing: missing.length, ...selectionBytes(rows) });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setPlan({ state: "error", message: errorText(reason, "Could not get the photos ready.") });
      });
    return () => controller.abort();
    // The ids are read as of the change in count; the loaded rows only save
    // requests, so a new page arriving need not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wanted, attempt]);

  const start = async () => {
    if (plan.state !== "ready" || plan.rows.length === 0 || starting) return;
    setStarting(true);
    // The save dialog must open straight from the click, before anything else waits.
    const target = await openZipTarget(zipFileName(new Date(), albumName));
    if (!target) {
      setStarting(false);
      return;
    }
    onOpenChange(false);
    onStarted();
    void runDownload(plan.rows, target);
  };

  const ready = plan.state === "ready" ? plan : null;
  // Without a save dialog the whole zip is held in memory first, and a phone
  // can run out of it far below 2 GB; the warning comes much sooner there.
  const inMemory = open && zipBuildsInMemory();
  const large = ready !== null && isLargeDownload(ready.bytes, inMemory);

  return (
    <SheetShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Download ${plural(photoIds.length, "photo")}`}
      footer={
        <Button
          onClick={() => void start()}
          disabled={!ready || ready.rows.length === 0 || starting}
          className={primaryButton}
          size="lg"
        >
          {large ? "Download anyway" : "Download"}
        </Button>
      }
    >
      <div className="space-y-3 text-sm text-[#d0d0d0]">
        {plan.state === "loading" && <p role="status">Working out the size…</p>}
        {plan.state === "error" && (
          <div role="alert" className="space-y-2">
            <p className="text-red-200">{plan.message}</p>
            <Button variant="outline" className="min-h-11" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        )}
        {ready && (
          <p data-testid="download-total" className="text-base text-white">
            {ready.rows.length === 0
              ? "None of these photos are available any more."
              : `${plural(ready.rows.length, "photo")} in one zip file, ${ready.unknown > 0 ? "at least " : ""}${formatDownloadSize(ready.bytes)}.`}
          </p>
        )}
        {ready && ready.missing > 0 && ready.rows.length > 0 && (
          <p>
            {plural(ready.missing, "photo")} {ready.missing === 1 ? "is" : "are"} no longer available (trashed or
            deleted) and will be left out.
          </p>
        )}
        {large && (
          <p
            role="alert"
            data-testid="download-size-warning"
            className="rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-amber-200"
          >
            {!inMemory
              ? "This is over 2 GB. It can take a long time and may not finish. Downloading fewer photos at a time is safer."
              : isPhone
                ? "This phone may run out of memory before the zip is saved, and then nothing is saved. Select fewer photos and download them in a few parts."
                : "This browser holds the whole zip in memory before saving it, and may run out. Select fewer photos and download them in a few parts, or use Chrome or Edge, which save as they go."}
          </p>
        )}
        {isPhone && <p data-testid="download-phone-note">Large downloads work best on a computer.</p>}
        {ready && ready.rows.length > 0 && (
          <p className="text-[#b4b4b4]">Each photo keeps its name and its original file, at full quality.</p>
        )}
      </div>
    </SheetShell>
  );
}

export default memo(DownloadSheet);
