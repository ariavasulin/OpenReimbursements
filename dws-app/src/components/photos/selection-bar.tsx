"use client";

import { runPhotoAction } from "@/lib/photos/trash-now";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookImage,
  BookMinus,
  Briefcase,
  Download,
  MoreHorizontal,
  Tag,
  TextCursorInput,
  Trash2,
  X,
  type LucideIcon,
  Heart,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AlbumField from "@/components/photos/album-field";
import { PHOTOS_FLOATING_SLOT_ID, usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import SetProjectSheet from "@/components/photos/set-project-sheet";
import SheetShell from "@/components/photos/sheet-shell";
import TagDropdown, { useTagChoices } from "@/components/photos/tag-dropdown";
import { useDesktop } from "@/hooks/use-desktop";
import { useMobile } from "@/hooks/use-mobile";
import {
  addPhotosToAlbum,
  bulkTagPhotos,
  fetchPhotosPage,
  invalidatePhotoCaches,
  PHOTO_ACTOR_KEY,
  removePhotosFromAlbum,
  renamePhoto,
  usePhotoActor,
  usePhotoDetail,
  type PhotoIdsAnswer, setFavorites, patchFavorites } from "@/lib/photos/api";
import { MAX_BULK_PHOTOS, MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { inChunks, PartialBulkError, sumCounts } from "@/lib/photos/chunks";
import { formatCount, photoName, plural } from "@/lib/photos/format";
import { MAX_SELECTION } from "@/lib/photos/selection";
import {
  desktopActions,
  phoneActions,
  selectionActions,
  type SelectionActionKey,
} from "@/lib/photos/selection-actions";
import { appendResolvedTag } from "@/lib/photos/tags";
import { trashActionLabel, trashableIds } from "@/lib/photos/permissions";
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
// for Trash, the ones this person may delete (trashableIds), so the button
// never promises what the server will refuse. Download confirms the count and
// size, then saves every selected original as one zip (lib/photos/zip-download.ts).
//
// Layout. Desktop: one row — clear and the count on the left, the actions in
// one fixed order on the right, Trash last behind a divider. Actions that do
// not fit the row's width go into a "More" menu, least used first, so the bar
// never wraps. Phone: the count on top, then a bottom row of icon-over-label
// buttons; past PHONE_SLOTS the least used go into a "More" sheet. Trash is
// never folded away on either.

interface SelectionBarProps {
  selectedIds: ReadonlySet<string>;
  onClear(): void;
  /** Inside an album: adds "Remove from album". */
  album?: PhotoAlbumRef;
  /** The Favorites filter is on: the heart action takes photos out instead of in. */
  inFavorites?: boolean;
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

const focusRing = "focus:outline-none focus-visible:ring-2 focus-visible:ring-white";
/** A desktop action: icon and label in one line. Also the measuring copies' class, so widths match. */
const desktopAction = `flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium disabled:opacity-50 ${focusRing}`;
/** A phone action: icon over label, a full-height ≥44 px slot. Width comes from the caller's flex share. */
const phoneAction = `flex min-h-14 min-w-0 basis-0 flex-col items-center justify-center gap-1 rounded-lg px-0.5 py-1.5 text-center text-xs font-medium leading-tight disabled:opacity-50 ${focusRing}`;
// Colours stay out of the shared classes: Tailwind's output order, not the
// class order, would decide between two text colours on one button.
const plainTone = "text-white hover:bg-white/10 active:bg-white/15";
const trashTone = "text-red-200 hover:bg-red-500/15 active:bg-red-500/20";
const menuItem =
  "flex min-h-11 cursor-pointer items-center gap-3 px-3 text-base text-white focus:bg-[#3e3e3e] focus:text-white";
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

type SheetKey = "album" | "tag" | "project" | "rename" | "download" | "more";
type Measured = { available: number; widths: Partial<Record<SelectionActionKey | "more", number>> };

const MIXED_TRASH_TAIL = " you can delete";

export default function SelectionBar({
  selectedIds,
  onClear,
  album,
  inFavorites = false,
  limitMessage,
  photos,
  listQuery,
  sharedJobId,
  allMatches,
  onSelectAll,
}: SelectionBarProps) {
  const queryClient = useQueryClient();
  const isDesktop = useDesktop();
  const { setSelecting } = usePhotosShell();
  const actor = usePhotoActor();
  const count = selectedIds.size;
  const ids = [...selectedIds];
  const trashable = useMemo(() => trashableIds(actor, selectedIds, photos), [actor, photos, selectedIds]);
  const trashLabel = trashActionLabel(trashable.length, count);
  // "Select all" while some match that are not selected and there is room.
  const selectAllLabel = useMemo(() => {
    if (!allMatches || count >= MAX_SELECTION) return null;
    if (allMatches.ids.every((id) => selectedIds.has(id))) return null;
    return allMatches.truncated
      ? `Select all ${formatCount(allMatches.ids.length)} (of ${formatCount(allMatches.total)})`
      : `Select all ${formatCount(allMatches.total)}`;
  }, [allMatches, count, selectedIds]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Rename needs the one selected photo's current name.
  const { data: only, error: onlyError } = usePhotoDetail(sheet === "rename" && count === 1 ? ids[0] : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSlot(document.getElementById(PHOTOS_FLOATING_SLOT_ID)), []);
  // The shell hides its "+" button while this bar is up.
  const selecting = count > 0;
  useEffect(() => {
    setSelecting(selecting);
    return () => setSelecting(false);
  }, [selecting, setSelecting]);
  // Starting a selection re-asks "may I trash anything?" if the answer is over
  // 30 seconds old, so a Photo admin box ticked since shows here at once.
  useEffect(() => {
    if (selecting) void queryClient.refetchQueries({ queryKey: PHOTO_ACTOR_KEY, stale: true });
  }, [selecting, queryClient]);

  const done = () => {
    invalidatePhotoCaches(queryClient);
    onClear();
  };

  // Esc clears the selection, as it would close any other transient layer —
  // unless a pop-up or the More menu is open, which Esc closes instead.
  useEffect(() => {
    if (count === 0 || sheet !== null || menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClear();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [count, sheet, menuOpen, onClear]);

  const trash = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // No confirmation (owner ruling): Trash is restorable for 30 days, and the
      // toast offers Undo. Photos the rule refuses are left out and counted.
      const result = await runPhotoAction("trash", trashable);
      onClear();
      invalidatePhotoCaches(queryClient);
      const moved = result.photoIds.length;
      if (moved === 0) {
        toast.error("None of those photos could be moved to Trash.");
      } else {
        toast.success(`Moved ${plural(moved, "photo")} to Trash`, {
          description: result.leftOut > 0 ? `${plural(result.leftOut, "photo")} left out: not yours to delete.` : undefined,
          action: {
            label: "Undo",
            onClick: () => {
              void runPhotoAction("restore", result.photoIds)
                .then(() => { invalidatePhotoCaches(queryClient); toast.success(`Restored ${plural(moved, "photo")}`); })
                .catch((reason) => toast.error(errorText(reason, "Could not restore those photos.")));
            },
          },
        });
      }
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

  // Personal hearts on the whole selection: in, or on the Favorites page, out.
  const favoriteAll = async () => {
    const on = !inFavorites;
    const photoIds = ids;
    if (busy) return;
    setBusy(true);
    try {
      const { results, toastId } = await sendInSlices(
        photoIds,
        (chunk) => setFavorites(chunk, on),
        (sent, total) => `${on ? "Adding" : "Removing"} ${plural(total, "photo")}… ${formatCount(sent)} done`
      );
      const { updated } = sumCounts(results, ["updated"]);
      if (actor) patchFavorites(queryClient, photoIds, actor.user_id, on);
      toast.success(
        on ? `Added ${plural(updated, "photo")} to your favorites` : `Removed ${plural(updated, "photo")} from your favorites`,
        {
          id: toastId,
          description: "Only you see your favorites.",
          action: {
            label: "Undo",
            onClick: () => {
              void inChunks(photoIds, (chunk) => setFavorites(chunk, !on)).then(() => {
                if (actor) patchFavorites(queryClient, photoIds, actor.user_id, !on);
                if (inFavorites) invalidatePhotoCaches(queryClient);
              });
            },
          },
        }
      );
      if (inFavorites) invalidatePhotoCaches(queryClient);
      onClear();
    } catch (reason) {
      toast.error(sliceError(reason, on ? "Could not add to favorites" : "Could not remove from favorites", (n) => `${on ? "Added" : "Removed"} ${n}`));
      invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };

  const actions: Record<SelectionActionKey, { label: string; icon: LucideIcon; run(): void; testId?: string }> = {
    download: { label: "Download", icon: Download, run: () => setSheet("download"), testId: "selection-download" },
    album: { label: "Add to album", icon: BookImage, run: () => setSheet("album") },
    remove: {
      label: "Remove from album",
      icon: BookMinus,
      run: () => {
        setSheet(null);
        void removeFromAlbum();
      },
    },
    tag: { label: "Tag", icon: Tag, run: () => setSheet("tag") },
    favorite: {
      label: inFavorites ? "Unfavorite" : "Favorite",
      icon: Heart,
      run: () => {
        setSheet(null);
        void favoriteAll();
      },
    },
    project: { label: "Set project", icon: Briefcase, run: () => setSheet("project") },
    rename: { label: "Rename", icon: TextCursorInput, run: () => setSheet("rename") },
  };
  const keys = selectionActions({ inAlbum: Boolean(album), count });
  const keysSignature = keys.join(" ");

  // Desktop: measure each action's width (hidden copies) and the room the row
  // leaves for them, before paint and again whenever the row resizes.
  const actionsRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const visible = Boolean(slot) && count > 0;
  useLayoutEffect(() => {
    if (!isDesktop || !visible) return;
    const box = actionsRef.current;
    const ruler = rulerRef.current;
    if (!box || !ruler) return;
    const measure = () => {
      const widths: Measured["widths"] = {};
      ruler.querySelectorAll<HTMLElement>("[data-measure]").forEach((element) => {
        widths[element.dataset.measure as SelectionActionKey | "more"] = Math.ceil(element.getBoundingClientRect().width);
      });
      const available = box.clientWidth;
      setMeasured((previous) =>
        previous &&
        previous.available === available &&
        JSON.stringify(previous.widths) === JSON.stringify(widths)
          ? previous
          : { available, widths }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(ruler); // the widths change once the web font loads
    return () => observer.disconnect();
  }, [isDesktop, visible, keysSignature]);

  if (!slot || count === 0) return null;

  const fit = isDesktop
    ? measured
      ? desktopActions(keys, measured.widths, measured.available)
      : { shown: keys, more: [] }
    : phoneActions(keys, trashLabel !== null);
  const mixedTrash = trashLabel !== null && trashLabel !== "Trash";
  // On a phone it reads as two even lines: "Trash the 3" / "you can delete".
  const phoneTrashLabel =
    trashLabel !== null && trashLabel.endsWith(MIXED_TRASH_TAIL) ? (
      <>
        <span className="block">{trashLabel.slice(0, -MIXED_TRASH_TAIL.length)}</span>{" "}
        <span className="block">{MIXED_TRASH_TAIL.trim()}</span>
      </>
    ) : (
      trashLabel
    );

  const selectAll = selectAllLabel && allMatches && (
    <button
      type="button"
      data-testid="selection-select-all"
      disabled={busy}
      onClick={() => onSelectAll(allMatches)}
      className={
        isDesktop
          ? `-mx-1 rounded px-1 text-left text-sm font-medium leading-snug text-[#8bbaff] hover:text-white hover:underline disabled:opacity-50 ${focusRing}`
          : `flex min-h-11 items-center rounded-lg px-1.5 text-base font-medium text-[#8bbaff] hover:text-white disabled:opacity-50 ${focusRing}`
      }
    >
      {selectAllLabel}
    </button>
  );
  const countText = (
    <span data-testid="selection-count" aria-live="polite" className="text-base font-semibold leading-snug text-white">
      {formatCount(count)} selected
    </span>
  );
  const clearButton = (
    <button
      type="button"
      onClick={onClear}
      aria-label="Clear selection"
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white hover:bg-white/10 ${focusRing}`}
    >
      <X className="h-5 w-5" aria-hidden="true" />
    </button>
  );
  const divider = (
    <span aria-hidden="true" className={isDesktop ? "mx-1 h-7 w-px shrink-0 bg-white/20" : "my-2 w-px shrink-0 bg-white/15"} />
  );

  const desktopRow = (
    <div className="relative flex items-center gap-2 px-1.5 py-1">
      {clearButton}
      <div className="flex shrink-0 flex-col items-start pr-2">
        {countText}
        {selectAll}
      </div>
      <div ref={actionsRef} className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {fit.shown.map((key) => {
          const { label, icon: Icon, run, testId } = actions[key];
          return (
            <button key={key} type="button" data-testid={testId} className={`${desktopAction} ${plainTone}`} disabled={busy} onClick={run}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          );
        })}
        {fit.more.length > 0 && (
          <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={`${desktopAction} ${plainTone}`} disabled={busy}>
                <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
                More
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-52 border-[#4e4e4e] bg-[#2e2e2e] p-1 text-white"
              // A chosen action opens its own pop-up, which takes the focus.
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {fit.more.map((key) => {
                const { label, icon: Icon, run, testId } = actions[key];
                return (
                  <DropdownMenuItem key={key} data-testid={testId} className={menuItem} disabled={busy} onSelect={run}>
                    <Icon className="h-5 w-5 text-[#b4b4b4]" aria-hidden="true" />
                    {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {trashLabel && (
        <>
          {divider}
          <button
            type="button"
            data-testid="selection-trash"
            className={`${desktopAction} ${trashTone}`}
            disabled={busy}
            onClick={() => void trash()}
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {trashLabel}
          </button>
        </>
      )}
      {/* Hidden copies of every action, for their widths. No test ids, no roles. */}
      <div aria-hidden="true" inert className="pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden">
        <div ref={rulerRef} className="flex w-max">
          {keys.map((key) => {
            const { label, icon: Icon } = actions[key];
            return (
              <span key={key} data-measure={key} className={desktopAction}>
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </span>
            );
          })}
          <span data-measure="more" className={desktopAction}>
            <MoreHorizontal className="h-4 w-4 shrink-0" />
            More
          </span>
        </div>
      </div>
    </div>
  );

  const phoneButton = (key: string, label: ReactNode, Icon: LucideIcon, onClick: () => void, extra?: { testId?: string; className?: string; popup?: boolean }) => (
    <button
      key={key}
      type="button"
      data-testid={extra?.testId}
      aria-haspopup={extra?.popup ? "dialog" : undefined}
      className={`${phoneAction} ${extra?.className ?? `grow ${plainTone}`}`}
      disabled={busy}
      onClick={onClick}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="block">{label}</span>
    </button>
  );
  const phoneRows = (
    <>
      <div className="flex items-center gap-1 px-1 pt-1">
        {clearButton}
        {/* A long "Select all 5,000 (of 12,345)" wraps under the count. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
          {countText}
          {selectAll}
        </div>
      </div>
      <div className="flex items-stretch gap-0.5 px-1 pb-1">
        {fit.shown.map((key) => {
          const { label, icon, run, testId } = actions[key];
          return phoneButton(key, label, icon, run, { testId });
        })}
        {fit.more.length > 0 && phoneButton("more", "More", MoreHorizontal, () => setSheet("more"), { popup: true })}
        {trashLabel && (
          <>
            {(fit.shown.length > 0 || fit.more.length > 0) && divider}
            {phoneButton(
              "trash",
              phoneTrashLabel,
              Trash2,
              () => void trash(),
              { testId: "selection-trash", className: `${trashTone} ${mixedTrash ? "grow-[1.4]" : "grow"}` }
            )}
          </>
        )}
      </div>
    </>
  );

  return (
    <>
      {createPortal(
        <div
          role="region"
          aria-label="Selected photos"
          className={`pointer-events-auto mx-auto w-full rounded-xl border border-[#2680FC]/60 bg-[#1f2c40] shadow-xl shadow-black/50 ${isDesktop ? "max-w-6xl" : "max-w-xl"}`}
        >
          {isDesktop ? desktopRow : phoneRows}
          {limitMessage && (
            <p
              role="status"
              data-testid="selection-message"
              className="border-t border-[#2680FC]/40 px-3 py-2 text-sm text-amber-200"
            >
              {limitMessage}
            </p>
          )}
        </div>,
        slot
      )}

      <SheetShell open={sheet === "more"} onOpenChange={(open) => setSheet(open ? "more" : null)} title={`More for ${plural(count, "photo")}`}>
        <div className="-mx-2 flex flex-col">
          {fit.more.map((key) => {
            const { label, icon: Icon, run, testId } = actions[key];
            return (
              <button
                key={key}
                type="button"
                data-testid={testId}
                disabled={busy}
                onClick={run}
                className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-base text-white hover:bg-white/10 active:bg-white/15 disabled:opacity-50 ${focusRing}`}
              >
                <Icon className="h-5 w-5 shrink-0 text-[#b4b4b4]" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </SheetShell>

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
  // Add is the usual job; Remove is how a tag given to the wrong photos comes
  // off them all at once (group by Tag, tick the group, Tag, Remove).
  const [mode, setMode] = useState<"add" | "remove">("add");

  useEffect(() => {
    if (open) {
      setTags([]);
      setInput("");
      setMode("add");
    }
  }, [open]);

  const pending = appendResolvedTag(tags, input, choices.spellings);
  const removing = mode === "remove";

  const save = async () => {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    try {
      const { results, toastId } = await sendInSlices(
        photoIds,
        (chunk) => bulkTagPhotos(chunk, removing ? { remove: pending } : { add: pending }),
        (sent, total) => `${removing ? "Untagging" : "Tagging"} ${plural(total, "photo")}… ${formatCount(sent)} done`
      );
      const result = sumCounts(results, ["updated", "skipped", "missing"]);
      const detail = [
        result.skipped > 0 && `${plural(result.skipped, "photo")} skipped: a photo can hold 20 tags`,
        result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
      ].filter(Boolean).join(" · ");
      toast.success(
        removing
          ? `Removed ${pending.join(", ")} from ${plural(result.updated, "photo")}`
          : `Tagged ${plural(result.updated, "photo")} ${pending.join(", ")}`,
        { id: toastId, description: detail || undefined }
      );
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(sliceError(reason, removing ? "Failed to remove the tags" : "Failed to tag the photos", (n) => `${removing ? "Untagged" : "Tagged"} ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };
  const modeButton = (value: "add" | "remove", label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      disabled={busy}
      onClick={() => setMode(value)}
      className={`min-h-11 flex-1 rounded-lg px-3 text-base font-medium ${
        mode === value ? "bg-[#2680FC] text-white" : "bg-[#3a3a3a] text-[#d0d0d0] hover:bg-[#454545]"
      }`}
    >
      {label}
    </button>
  );

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
          {busy ? "Saving..." : `${removing ? "Remove" : "Add"} ${pending.length > 1 ? "tags" : "tag"}`}
        </Button>
      }
    >
      <div role="radiogroup" aria-label="Add or remove" className="mb-3 flex gap-2">
        {modeButton("add", "Add tags")}
        {modeButton("remove", "Remove tags")}
      </div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[#d0d0d0]">
        {removing ? "Tags to remove" : "Tags to add"}
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
