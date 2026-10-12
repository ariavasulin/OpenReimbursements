"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { BookImage, BookMinus, Briefcase, Tag, TextCursorInput, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import AlbumField from "@/components/photos/album-field";
import { PHOTOS_FLOATING_SLOT_ID, usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import SetProjectSheet from "@/components/photos/set-project-sheet";
import SheetShell from "@/components/photos/sheet-shell";
import TagDropdown, { useTagChoices } from "@/components/photos/tag-dropdown";
import {
  addPhotosToAlbum,
  bulkTagPhotos,
  createActionBatch,
  invalidatePhotoCaches,
  removePhotosFromAlbum,
  renamePhoto,
  usePhotoActor,
  usePhotoDetail,
} from "@/lib/photos/api";
import { MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { photoName, plural } from "@/lib/photos/format";
import { appendResolvedTag } from "@/lib/photos/tags";
import { canTrashPhoto, isPhotoAdmin } from "@/lib/photos/permissions";
import type { PhotoAlbumRef, PhotoRow } from "@/lib/photos/types";

// The bar that appears once photos are selected: the count and what can be done
// with them. Add to album, Tag, and Remove from album act at once (they only
// add or take away a label, and are easy to undo). Set project and Trash open
// the confirm page with exactly the selected photos — for Trash, the ones this
// person may delete, so the button never promises what the server will refuse.

interface SelectionBarProps {
  selectedIds: ReadonlySet<string>;
  onClear(): void;
  /** Inside an album: adds "Remove from album". */
  album?: PhotoAlbumRef;
  /** A tick was refused at the 500 limit. */
  limitMessage: string | null;
  /** The loaded photos, so Trash can count which selected ones this person may delete. */
  photos: readonly Pick<PhotoRow, "id" | "uploader_id" | "created_at">[];
  /** The one project every selected photo is in, so Tag suggests that
   *  project's tags; null when they differ or have none (every tag). */
  sharedJobId: string | null;
}

const actionClass =
  "flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50";
const primaryButton =
  "h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]";

const errorText = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;

export default function SelectionBar({
  selectedIds,
  onClear,
  album,
  limitMessage,
  photos,
  sharedJobId,
}: SelectionBarProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setSelecting } = usePhotosShell();
  const actor = usePhotoActor();
  const count = selectedIds.size;
  const ids = [...selectedIds];
  // A selected photo that is not loaded counts as not deletable; SQL decides either way.
  const trashable = useMemo(() => {
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    return [...selectedIds].filter((id) => {
      const photo = byId.get(id);
      return isPhotoAdmin(actor) || (photo !== undefined && canTrashPhoto(actor, photo));
    });
  }, [actor, photos, selectedIds]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<"album" | "tag" | "project" | "rename" | null>(null);
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
      const { removed } = await removePhotosFromAlbum(album.id, ids);
      toast.success(`Removed ${plural(removed, "photo")} from “${album.name}”`, {
        description: "The photos are still in Photos.",
        action: {
          label: "Undo",
          onClick: () =>
            void addPhotosToAlbum(album.id, ids)
              .then(() => invalidatePhotoCaches(queryClient))
              .catch((reason) => toast.error(errorText(reason, "Could not undo that."))),
        },
      });
      done();
    } catch (reason) {
      toast.error(errorText(reason, "Failed to remove from the album"));
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
            <span
              data-testid="selection-count"
              aria-live="polite"
              className="mr-auto pr-2 text-base font-semibold text-white"
            >
              {count} selected
            </span>
            {count === 1 && (
              <button type="button" className={actionClass} disabled={busy} onClick={() => setSheet("rename")}>
                <TextCursorInput className="h-4 w-4" aria-hidden="true" />
                Rename
              </button>
            )}
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
        const result = await addPhotosToAlbum(album.id, photoIds);
        const detail = [
          result.already > 0 && `${plural(result.already, "photo")} already there`,
          result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
        ].filter(Boolean).join(" · ");
        toast.success(`Added ${plural(result.added, "photo")} to “${album.name}”`, {
          description: detail || undefined,
          // Undo takes the photos out again, so it is only offered when that
          // cannot remove one that was in the album before.
          action:
            result.already === 0
              ? {
                  label: "Undo",
                  onClick: () =>
                    void removePhotosFromAlbum(album.id, photoIds)
                      .then(() => invalidatePhotoCaches(queryClient))
                      .catch((reason) => toast.error(errorText(reason, "Could not undo that."))),
                }
              : undefined,
        });
      }
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(errorText(reason, "Failed to add to the album"));
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
      const result = await bulkTagPhotos(photoIds, { add: pending });
      const detail = [
        result.skipped > 0 && `${plural(result.skipped, "photo")} skipped: a photo can hold 20 tags`,
        result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
      ].filter(Boolean).join(" · ");
      toast.success(`Tagged ${plural(result.updated, "photo")} ${pending.join(", ")}`, {
        description: detail || undefined,
      });
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(errorText(reason, "Failed to tag the photos"));
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
