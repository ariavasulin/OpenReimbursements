"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PHOTOS_FLOATING_SLOT_ID, usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import SetProjectSheet from "@/components/photos/set-project-sheet";
import SheetShell from "@/components/photos/sheet-shell";
import AddToAlbumSheet from "@/components/photos/selection/add-to-album-sheet";
import BulkTagSheet from "@/components/photos/selection/bulk-tag-sheet";
import { errorText, sendInSlices, sliceError } from "@/components/photos/selection/bulk-feedback";
import { useDesktop } from "@/hooks/use-desktop";
import {
  addPhotosToAlbum,
  invalidatePhotoCaches,
  PHOTO_ACTOR_KEY,
  removePhotosFromAlbum,
  renamePhoto,
  usePhotoActor,
  usePhotoDetail,
  type PhotoIdsAnswer, setFavorites, patchFavorites } from "@/lib/photos/api";
import { MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { inChunks, MAX_ACTION_RUN_PHOTOS, PartialBulkError, sumCounts } from "@/lib/photos/chunks";
import { formatCount, photoName, plural } from "@/lib/photos/format";
import { MAX_SELECTION } from "@/lib/photos/selection";
import {
  desktopActions,
  phoneActions,
  selectionActions,
  type SelectionActionKey,
} from "@/lib/photos/selection-actions";
import { trashActionLabel, trashableIds } from "@/lib/photos/permissions";
import { runPhotoAction } from "@/lib/photos/trash-now";
import type { PhotoAlbumRef, PhotoRow } from "@/lib/photos/types";
import type { ZipRow } from "@/lib/photos/zip-download";

// The zip code (client-zip) loads when Download is first chosen, or on idle
// once a selection starts (below), not with the grid.
const loadDownloadSheet = () => import("@/components/photos/selection/download-sheet");
const DownloadSheet = dynamic(loadDownloadSheet, { ssr: false });

// The bar that appears once photos are selected: the count, "Select all" when
// more photos match than are selected, and what can be done with them. Add to
// album, Tag, and Remove from album act at once (they only add or take away a
// label, and are easy to undo); their routes take 500 photos a request, so a
// bigger selection goes in slices under one progress toast. Trash acts at once
// too, on the photos this person may delete (trashableIds), so the button
// never promises what the server will refuse; the server runs it, 1,000 photos
// a request, and the toast offers Undo. Set project opens the confirm page
// with exactly the selected photos, as one batch. Download confirms the count
// and size, then saves every selected original as one zip
// (selection/download-sheet.tsx).
//
// Each pop-up lives in its own file under selection/ and is mounted the first
// time it opens (then kept, so it can animate closed), not on every tick.
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
  /** No longer read: Download now looks up unloaded photos by id
   *  (POST /api/photos/rows). Optional so PhotoBrowser can stop passing it. */
  listQuery?: string;
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

/**
 * Trash and its Undo while they run: "Moving 3 photos to Trash…", and past one
 * request's worth (MAX_ACTION_RUN_PHOTOS) how many are done so far.
 */
const runProgress = (verb: string, where: string, sent: number, total: number) =>
  `${verb} ${plural(total, "photo")}${where ? ` ${where}` : ""}…${total > MAX_ACTION_RUN_PHOTOS ? ` ${formatCount(sent)} done` : ""}`;

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
  sharedJobId,
  allMatches,
  onSelectAll,
}: SelectionBarProps) {
  const queryClient = useQueryClient();
  const isDesktop = useDesktop();
  const { setSelecting } = usePhotosShell();
  const actor = usePhotoActor();
  const count = selectedIds.size;
  // One copy per selection change, so the pop-ups' props stay the same between ticks.
  const ids = useMemo(() => [...selectedIds], [selectedIds]);
  const trashable = useMemo(() => trashableIds(actor, selectedIds, photos), [actor, photos, selectedIds]);
  const trashLabel = trashActionLabel(trashable.length, count);
  // "Select all" while some match that are not selected and there is room.
  const selectAllLabel = useMemo(() => {
    if (!allMatches || count >= MAX_SELECTION) return null;
    // More matches than selected photos: some match is certainly not selected,
    // without walking up to 5,000 ids on every tick.
    if (allMatches.ids.length <= count && allMatches.ids.every((id) => selectedIds.has(id))) return null;
    return allMatches.truncated
      ? `Select all ${formatCount(allMatches.ids.length)} (of ${formatCount(allMatches.total)})`
      : `Select all ${formatCount(allMatches.total)}`;
  }, [allMatches, count, selectedIds]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<SheetKey | null>(null);
  // Pop-ups opened during this selection. One is mounted when it first opens
  // and kept until the selection ends, so it can animate closed; the others
  // are never mounted, and cost nothing on a tick.
  const [opened, setOpened] = useState<ReadonlySet<SheetKey>>(() => new Set());
  const openSheet = useCallback((key: SheetKey) => {
    setOpened((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));
    setSheet(key);
  }, []);
  const mounted = (key: SheetKey) => sheet === key || opened.has(key);
  // Each pop-up's open/close handler, the same function every render.
  const sheetChange = useMemo(() => {
    const handler = (key: SheetKey) => (open: boolean) => setSheet(open ? key : null);
    return { album: handler("album"), tag: handler("tag"), project: handler("project"), rename: handler("rename"), download: handler("download"), more: handler("more") };
  }, []);
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
  // A selection that ends takes its pop-ups with it. One that starts fetches
  // the Download pop-up's code a moment later, so it opens at once when asked.
  useEffect(() => {
    if (!selecting) {
      setOpened((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    const timer = setTimeout(() => void loadDownloadSheet(), 1000);
    return () => clearTimeout(timer);
  }, [selecting]);

  const done = useCallback(() => {
    invalidatePhotoCaches(queryClient);
    onClear();
  }, [queryClient, onClear]);

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
    // One toast says it is working (counting up past one request's worth),
    // then becomes the outcome.
    const toastId = toast.loading(runProgress("Moving", "to Trash", 0, trashable.length));
    try {
      // No confirmation (owner ruling): Trash is restorable for 30 days, and the
      // toast offers Undo. Photos the rule refuses are left out and counted.
      const result = await runPhotoAction("trash", trashable, (sent, total) => {
        if (sent < total) toast.loading(runProgress("Moving", "to Trash", sent, total), { id: toastId });
      });
      onClear();
      invalidatePhotoCaches(queryClient);
      const moved = result.photoIds.length;
      const notes = [
        result.leftOut > 0 && `${plural(result.leftOut, "photo")} left out: not yours to delete.`,
        result.failed > 0 && `${plural(result.failed, "photo")} changed just now and stayed put.`,
      ].filter(Boolean).join(" ");
      if (moved === 0) {
        toast.error("None of those photos could be moved to Trash.", { id: toastId, description: notes || undefined });
      } else {
        toast.success(`Moved ${plural(moved, "photo")} to Trash`, {
          id: toastId,
          description: notes || undefined,
          action: {
            label: "Undo",
            onClick: () => {
              const undoId = toast.loading(runProgress("Restoring", "", 0, moved));
              void runPhotoAction("restore", result.photoIds, (sent, total) => {
                if (sent < total) toast.loading(runProgress("Restoring", "", sent, total), { id: undoId });
              })
                .then(() => toast.success(`Restored ${plural(moved, "photo")}`, { id: undoId }))
                .catch((reason) =>
                  toast.error(sliceError(reason, "Could not restore those photos.", (n) => `Restored ${n}`), { id: undoId })
                )
                .finally(() => invalidatePhotoCaches(queryClient));
            },
          },
        });
      }
    } catch (reason) {
      toast.error(sliceError(reason, "Could not start that. Try again.", (n) => `Moved ${n} to Trash`), { id: toastId });
      // The selection stays, so Trash again finishes the rest.
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
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
    download: { label: "Download", icon: Download, run: () => openSheet("download"), testId: "selection-download" },
    album: { label: "Add to album", icon: BookImage, run: () => openSheet("album") },
    remove: {
      label: "Remove from album",
      icon: BookMinus,
      run: () => {
        setSheet(null);
        void removeFromAlbum();
      },
    },
    tag: { label: "Tag", icon: Tag, run: () => openSheet("tag") },
    favorite: {
      label: inFavorites ? "Unfavorite" : "Favorite",
      icon: Heart,
      run: () => {
        setSheet(null);
        void favoriteAll();
      },
    },
    project: { label: "Set project", icon: Briefcase, run: () => openSheet("project") },
    rename: { label: "Rename", icon: TextCursorInput, run: () => openSheet("rename") },
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
        {fit.more.length > 0 && phoneButton("more", "More", MoreHorizontal, () => openSheet("more"), { popup: true })}
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

      {mounted("more") && (
        <SheetShell open={sheet === "more"} onOpenChange={sheetChange.more} title={`More for ${plural(count, "photo")}`}>
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
      )}

      {mounted("album") && (
        <AddToAlbumSheet open={sheet === "album"} onOpenChange={sheetChange.album} photoIds={ids} onDone={done} />
      )}
      {mounted("tag") && (
        <BulkTagSheet
          open={sheet === "tag"}
          onOpenChange={sheetChange.tag}
          photoIds={ids}
          jobId={sharedJobId}
          onDone={done}
        />
      )}
      {mounted("rename") && (
        <RenameSheet
          open={sheet === "rename"}
          onOpenChange={sheetChange.rename}
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
      )}
      {mounted("project") && (
        <SetProjectSheet open={sheet === "project"} onOpenChange={sheetChange.project} photoIds={ids} onContinue={onClear} />
      )}
      {mounted("download") && (
        <DownloadSheet
          open={sheet === "download"}
          onOpenChange={sheetChange.download}
          photoIds={ids}
          loaded={photos}
          albumName={album?.name}
          onStarted={onClear}
        />
      )}
    </>
  );
}
