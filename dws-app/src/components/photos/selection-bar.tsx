"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { BookImage, BookMinus, Briefcase, Download, Tag, TextCursorInput, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import AlbumField from "@/components/photos/album-field";
import { PHOTOS_FLOATING_SLOT_ID, usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import SetProjectSheet from "@/components/photos/set-project-sheet";
import SheetShell from "@/components/photos/sheet-shell";
import TagDropdown, { useTagChoices } from "@/components/photos/tag-dropdown";
import { useMobile } from "@/hooks/use-mobile";
import {
  addPhotosToAlbum,
  bulkTagPhotos,
  createActionBatch,
  fetchPhotosPage,
  invalidatePhotoCaches,
  removePhotosFromAlbum,
  renamePhoto,
  usePhotoActor,
  usePhotoDetail,
  type PhotoIdsAnswer,
} from "@/lib/photos/api";
import { MAX_BULK_PHOTOS, MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { inChunks, PartialBulkError, sumCounts } from "@/lib/photos/chunks";
import { formatCount, photoName, plural } from "@/lib/photos/format";
import { MAX_SELECTION } from "@/lib/photos/selection";
import { appendResolvedTag } from "@/lib/photos/tags";
import { canTrashPhoto, isPhotoAdmin } from "@/lib/photos/permissions";
import type { PhotoAlbumRef, PhotoRow } from "@/lib/photos/types";
import {
  findRows,
  formatDownloadSize,
  isLargeDownload,
  selectionBytes,
  zipFileName,
  type ZipRow,
} from "@/lib/photos/zip-download";
import { openZipTarget, saveZip, ZipEmptyError, type ZipTarget } from "@/lib/photos/zip-save";

// The bar that appears once photos are selected: the count, "Select all" when
// more photos match than are selected, and what can be done with them. Add to
// album, Tag, and Remove from album act at once (they only add or take away a
// label, and are easy to undo); their routes take 500 photos a request, so a
// bigger selection goes in slices under one progress toast. Set project and
// Trash open the confirm page with exactly the selected photos, as one batch —
// for Trash, the ones this person may delete, so the button never promises
// what the server will refuse. Download confirms the count and size, then
// saves every selected original as one zip (lib/photos/zip-download.ts).

interface SelectionBarProps {
  selectedIds: ReadonlySet<string>;
  onClear(): void;
  /** Inside an album: adds "Remove from album". */
  album?: PhotoAlbumRef;
  /** A tick was refused at the selection limit, or "Select all" matched more than it holds. */
  limitMessage: string | null;
  /** The loaded photos, so Trash can count which selected ones this person may
   *  delete, and Download has their sizes and names without asking again. */
  photos: readonly (ZipRow & Pick<PhotoRow, "uploader_id" | "created_at">)[];
  /** The grid's GET /api/photos parameters, for Download to find selected
   *  photos that are not loaded yet. */
  listQuery: string;
  /** The one project every selected photo is in, so Tag suggests that
   *  project's tags; null when they differ or have none (every tag). */
  sharedJobId: string | null;
  /** Every photo the grid's filters match (GET /api/photos/ids), once known. */
  allMatches?: PhotoIdsAnswer;
  onSelectAll(answer: PhotoIdsAnswer): void;
}

const actionClass =
  "flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50";
const primaryButton =
  "h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]";

const errorText = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

/**
 * Send a bulk change in slices the route accepts. Past one slice, one toast
 * counts up while it runs; the caller's outcome toast replaces it (`toastId`).
 * A failure part way says how far it got: the slices sent are saved, and the
 * same change again finishes the rest.
 */
async function sendInSlices<T>(
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
const sliceError = (reason: unknown, fallback: string, done: (count: string) => string) =>
  reason instanceof PartialBulkError
    ? `${done(`${formatCount(reason.done)} of ${plural(reason.total, "photo")}`)}, then it stopped: ${reason.message.replace(/[.!?]?$/, ".")} Try again to finish.`
    : errorText(reason, fallback);

export default function SelectionBar({
  selectedIds,
  onClear,
  album,
  limitMessage,
  photos,
  listQuery,
  sharedJobId,
  allMatches,
  onSelectAll,
}: SelectionBarProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setSelecting } = usePhotosShell();
  const actor = usePhotoActor();
  const count = selectedIds.size;
  const ids = [...selectedIds];
  // A loaded photo is checked here. One selected through "Select all" or a
  // group tick and not loaded yet goes to the confirm page, which asks to leave
  // out any the server refuses; SQL decides either way.
  const trashable = useMemo(() => {
    if (!actor) return [];
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    return [...selectedIds].filter((id) => {
      const photo = byId.get(id);
      return isPhotoAdmin(actor) || photo === undefined || canTrashPhoto(actor, photo);
    });
  }, [actor, photos, selectedIds]);
  // "Select all" while some match that are not selected and there is room.
  const selectAllLabel = useMemo(() => {
    if (!allMatches || count >= MAX_SELECTION) return null;
    if (allMatches.ids.every((id) => selectedIds.has(id))) return null;
    return allMatches.truncated
      ? `Select all ${formatCount(allMatches.ids.length)} (of ${formatCount(allMatches.total)})`
      : `Select all ${formatCount(allMatches.total)}`;
  }, [allMatches, count, selectedIds]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<"album" | "tag" | "project" | "rename" | "download" | null>(null);
  // Rename needs the one selected photo's current name.
  const { data: only, error: onlyError } = usePhotoDetail(sheet === "rename" && count === 1 ? ids[0] : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSlot(document.getElementById(PHOTOS_FLOATING_SLOT_ID)), []);
  // The shell hides its "+" button while this bar is up.
  useEffect(() => {
    setSelecting(count > 0);
    return () => setSelecting(false);
  }, [count, setSelecting]);

  const done = () => {
    invalidatePhotoCaches(queryClient);
    onClear();
  };

  // Esc clears the selection, as it would close any other transient layer.
  useEffect(() => {
    if (count === 0 || sheet !== null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClear();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [count, sheet, onClear]);

  const trash = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const batchId = await createActionBatch({ action: "trash", photoIds: trashable });
      onClear();
      router.push(`/photos/actions?batch=${encodeURIComponent(batchId)}`);
    } catch (reason) {
      toast.error(errorText(reason, "Could not start that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const removeFromAlbum = async () => {
    if (!album || busy) return;
    setBusy(true);
    try {
      const { results, toastId } = await sendInSlices(
        ids,
        (chunk) => removePhotosFromAlbum(album.id, chunk),
        (sent, total) => `Removing ${plural(total, "photo")} from “${album.name}”… ${formatCount(sent)} done`
      );
      const { removed } = sumCounts(results, ["removed"]);
      toast.success(`Removed ${plural(removed, "photo")} from “${album.name}”`, {
        id: toastId,
        description: "The photos are still in Photos.",
        action: {
          label: "Undo",
          onClick: () =>
            void inChunks(ids, (chunk) => addPhotosToAlbum(album.id, chunk))
              .then(() => invalidatePhotoCaches(queryClient))
              .catch((reason) => toast.error(errorText(reason, "Could not undo that."))),
        },
      });
      done();
    } catch (reason) {
      toast.error(sliceError(reason, "Failed to remove from the album", (n) => `Removed ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };

  if (!slot || count === 0) return null;

  const message = limitMessage;

  return (
    <>
      {createPortal(
        <div
          role="region"
          aria-label="Selected photos"
          className="pointer-events-auto mx-auto w-full max-w-3xl rounded-xl border border-[#2680FC]/60 bg-[#1f2c40] shadow-xl shadow-black/50"
        >
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0 px-1.5 py-1">
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear selection"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-1 pr-2">
              <span
                data-testid="selection-count"
                aria-live="polite"
                className="text-base font-semibold text-white"
              >
                {formatCount(count)} selected
              </span>
              {selectAllLabel && allMatches && (
                <>
                  <span aria-hidden="true" className="text-[#8bbaff]">·</span>
                  <button
                    type="button"
                    data-testid="selection-select-all"
                    disabled={busy}
                    onClick={() => onSelectAll(allMatches)}
                    className="flex min-h-11 items-center rounded-lg px-1.5 text-base font-medium text-[#8bbaff] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
                  >
                    {selectAllLabel}
                  </button>
                </>
              )}
            </div>
            {count === 1 && (
              <button type="button" className={actionClass} disabled={busy} onClick={() => setSheet("rename")}>
                <TextCursorInput className="h-4 w-4" aria-hidden="true" />
                Rename
              </button>
            )}
            <button
              type="button"
              data-testid="selection-download"
              className={actionClass}
              disabled={busy}
              onClick={() => setSheet("download")}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => setSheet("album")}>
              <BookImage className="h-4 w-4" aria-hidden="true" />
              Add to album
            </button>
            <button type="button" className={actionClass} disabled={busy} onClick={() => setSheet("tag")}>
              <Tag className="h-4 w-4" aria-hidden="true" />
              Tag
            </button>
            <button
              type="button"
              className={actionClass}
              disabled={busy}
              onClick={() => {
                setSheet("project");
              }}
            >
              <Briefcase className="h-4 w-4" aria-hidden="true" />
              Set project
            </button>
            {album && (
              <button type="button" className={actionClass} disabled={busy} onClick={() => void removeFromAlbum()}>
                <BookMinus className="h-4 w-4" aria-hidden="true" />
                Remove from album
              </button>
            )}
            {trashable.length > 0 && (
              <button
                type="button"
                data-testid="selection-trash"
                className={`${actionClass} text-red-200`}
                disabled={busy}
                onClick={() => void trash()}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {trashable.length === count ? "Trash" : `Trash the ${trashable.length} you can delete`}
              </button>
            )}
          </div>
          {message && (
            <p
              role="status"
              data-testid="selection-message"
              className="border-t border-[#2680FC]/40 px-3 py-2 text-sm text-amber-200"
            >
              {message}
            </p>
          )}
        </div>,
        slot
      )}

      <AddToAlbumSheet
        open={sheet === "album"}
        onOpenChange={(open) => setSheet(open ? "album" : null)}
        photoIds={ids}
        onDone={done}
      />
      <BulkTagSheet
        open={sheet === "tag"}
        onOpenChange={(open) => setSheet(open ? "tag" : null)}
        photoIds={ids}
        jobId={sharedJobId}
        onDone={done}
      />
      <RenameSheet
        open={sheet === "rename"}
        onOpenChange={(open) => setSheet(open ? "rename" : null)}
        title="Rename photo"
        nameLabel="Photo name"
        name={only ? photoName(only) ?? "" : ""}
        allowEmpty
        maxLength={MAX_PHOTO_NAME_LENGTH}
        hint="Leave it empty to go back to the automatic name."
        loading={!only && !onlyError}
        loadError={onlyError ? "Could not load this photo's name. Close and try again." : undefined}
        onSave={async (name) => {
          await renamePhoto(ids[0], name);
          toast.success(name.trim() ? "Photo renamed" : "Name set back to the automatic name");
          done();
        }}
      />
      <SetProjectSheet
        open={sheet === "project"}
        onOpenChange={(open) => setSheet(open ? "project" : null)}
        photoIds={ids}
        onContinue={onClear}
      />
      <DownloadSheet
        open={sheet === "download"}
        onOpenChange={(open) => setSheet(open ? "download" : null)}
        photoIds={ids}
        loaded={photos}
        listQuery={listQuery}
        albumName={album?.name}
        onStarted={onClear}
      />
    </>
  );
}

interface BulkSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  photoIds: string[];
  /** The change is saved: refresh the grids and clear the selection. */
  onDone(): void;
}

function AddToAlbumSheet({ open, onOpenChange, photoIds, onDone }: BulkSheetProps) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [albums, setAlbums] = useState<PhotoAlbumRef[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setAlbums([]);
  }, [open]);

  const save = async () => {
    if (albums.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const album of albums) {
        const { results, toastId } = await sendInSlices(
          photoIds,
          (chunk) => addPhotosToAlbum(album.id, chunk),
          (sent, total) => `Adding ${plural(total, "photo")} to “${album.name}”… ${formatCount(sent)} done`
        );
        const result = sumCounts(results, ["added", "already", "missing"]);
        const detail = [
          result.already > 0 && `${plural(result.already, "photo")} already there`,
          result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
        ].filter(Boolean).join(" · ");
        toast.success(`Added ${plural(result.added, "photo")} to “${album.name}”`, {
          id: toastId,
          description: detail || undefined,
          // Undo takes the photos out again, so it is only offered when that
          // cannot remove one that was in the album before.
          action:
            result.already === 0
              ? {
                  label: "Undo",
                  onClick: () =>
                    void inChunks(photoIds, (chunk) => removePhotosFromAlbum(album.id, chunk))
                      .then(() => invalidatePhotoCaches(queryClient))
                      .catch((reason) => toast.error(errorText(reason, "Could not undo that."))),
                }
              : undefined,
        });
      }
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(sliceError(reason, "Failed to add to the album", (n) => `Added ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={`Add ${plural(photoIds.length, "photo")} to an album`}
      footer={
        <Button onClick={() => void save()} disabled={busy || albums.length === 0} className={primaryButton} size="lg">
          {busy ? "Adding..." : "Add to album"}
        </Button>
      }
    >
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[#d0d0d0]">
        Album
      </label>
      <AlbumField inputId={inputId} value={albums} onChange={setAlbums} enabled={open} disabled={busy} />
      <p className="mt-2 text-sm text-[#b4b4b4]">
        An album is like a folder. A photo can be in more than one, and it stays in its project.
      </p>
    </SheetShell>
  );
}

function BulkTagSheet({
  open,
  onOpenChange,
  photoIds,
  jobId,
  onDone,
}: BulkSheetProps & { jobId: string | null }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const choices = useTagChoices(open, jobId);
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTags([]);
      setInput("");
    }
  }, [open]);

  const pending = appendResolvedTag(tags, input, choices.spellings);

  const save = async () => {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    try {
      const { results, toastId } = await sendInSlices(
        photoIds,
        (chunk) => bulkTagPhotos(chunk, { add: pending }),
        (sent, total) => `Tagging ${plural(total, "photo")}… ${formatCount(sent)} done`
      );
      const result = sumCounts(results, ["updated", "skipped", "missing"]);
      const detail = [
        result.skipped > 0 && `${plural(result.skipped, "photo")} skipped: a photo can hold 20 tags`,
        result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
      ].filter(Boolean).join(" · ");
      toast.success(`Tagged ${plural(result.updated, "photo")} ${pending.join(", ")}`, {
        id: toastId,
        description: detail || undefined,
      });
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(sliceError(reason, "Failed to tag the photos", (n) => `Tagged ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={`Tag ${plural(photoIds.length, "photo")}`}
      footer={
        <Button onClick={() => void save()} disabled={busy || pending.length === 0} className={primaryButton} size="lg">
          {busy ? "Saving..." : pending.length > 1 ? "Add tags" : "Add tag"}
        </Button>
      }
    >
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[#d0d0d0]">
        Tags to add
      </label>
      <TagDropdown
        inputId={inputId}
        tags={tags}
        onChange={setTags}
        input={input}
        onInputChange={setInput}
        choices={choices}
        disabled={busy}
      />
    </SheetShell>
  );
}

/** Up to ten names, then "and N more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 10).join(", ");
  return names.length > 10 ? `${shown}, and ${formatCount(names.length - 10)} more` : shown;
}

/** GET /api/photos/[id] for Download: null when the photo is gone (404). */
async function fetchZipRow(id: string): Promise<ZipRow | null> {
  const response = await fetch(`/api/photos/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not look up a photo (${response.status})`);
  return ((await response.json()) as { photo: ZipRow }).photo;
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
  listQuery,
  albumName,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  photoIds: string[];
  loaded: readonly ZipRow[];
  listQuery: string;
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
    let current = true;
    setPlan({ state: "loading" });
    findRows(photoIds, loaded, listQuery, { page: fetchPhotosPage, one: fetchZipRow })
      .then(({ rows, missing }) => {
        if (current) setPlan({ state: "ready", rows, missing: missing.length, ...selectionBytes(rows) });
      })
      .catch((reason) => {
        if (current) setPlan({ state: "error", message: errorText(reason, "Could not get the photos ready.") });
      });
    return () => {
      current = false;
    };
    // The ids are read as of the change in count; the loaded rows only save
    // requests, so a new page arriving need not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wanted, listQuery, attempt]);

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
  const large = ready !== null && isLargeDownload(ready.bytes);

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
            This is over 2 GB. It can take a long time and may not finish, especially on a phone. Downloading fewer
            photos at a time is safer.
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
