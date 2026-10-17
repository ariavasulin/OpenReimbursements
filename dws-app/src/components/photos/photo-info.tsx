"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Download, Heart, Link2, Pencil, TextCursorInput, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  invalidatePhotoCaches,
  patchPhotoRows,
  removePhotosFromLists,
  renamePhoto,
  usePhotoActor,
  usePhotoDetail,
} from "@/lib/photos/api";
import { MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { buildPhotoLink } from "@/lib/photos/photo-link";
import { runPhotoAction } from "@/lib/photos/trash-now";
import { useFavorite } from "@/hooks/use-favorite";
import { trashDisclosure } from "@/lib/photos/action-client";
import { canTrashPhoto, TRASH_RULE_MESSAGE } from "@/lib/photos/permissions";
import {
  formatCapturedAt,
  formatFileInfo,
  NO_PROJECT,
  photoName,
} from "@/lib/photos/format";
import { downloadUrl, sidecarDownloadUrl } from "@/lib/photos/urls";
import { cn } from "@/lib/utils";
import type { PhotoRow } from "@/lib/photos/types";

// What the viewer knows about the open photo, and what can be done with it:
// the desktop viewer's side panel, and the body of the phone's "Details"
// pop-up. Opaque in both — never laid over the photo itself.

interface PhotoInfoProps {
  photo: PhotoRow;
  /** Opens "Edit tags" (owned by the lightbox, so it stacks above it). */
  onEdit(): void;
  /** Opens "Set project". */
  onSetProject(): void;
  /** A link inside is about to leave the viewer (an album). */
  onNavigate?(): void;
  /** The photo was just moved to Trash (and taken out of every cached list): the viewer should close. */
  onTrashed?(): void;
}

// One type scale for the phone sheet and the desktop panel (only the width
// differs): a small uppercase muted label over a body-size medium value. Albums
// and tags share one chip; "About this file" is a label/value list.
const factLabel = "mb-1 text-xs font-medium uppercase tracking-wider text-[#a0a0a0]";
const factValue = "text-base font-medium text-white";
const chip = "inline-flex min-h-8 items-center rounded-full bg-[#3a3a3a] px-3 text-base font-medium";
const fileFactLabel = "text-base text-[#a0a0a0]";
const action =
  "flex min-h-11 w-full items-center gap-3 rounded-lg border border-[#4e4e4e] bg-[#3a3a3a] px-3 text-base text-white hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]";
const actionIcon = "h-5 w-5 shrink-0 text-[#b4b4b4]";

export default function PhotoInfo({ photo, onEdit, onSetProject, onNavigate, onTrashed }: PhotoInfoProps) {
  const queryClient = useQueryClient();
  const { favorite, toggle: toggleFavorite } = useFavorite();
  const hearted = favorite(photo);
  const [trashing, setTrashing] = useState(false);
  // No confirmation (owner ruling): Trash is restorable for 30 days, and the
  // toast offers Undo right away.
  const moveToTrash = async () => {
    if (trashing) return;
    setTrashing(true);
    try {
      const result = await runPhotoAction("trash", [photo.id]);
      if (result.photoIds.length === 0) {
        // Left out or changed by someone else: the browser cannot tell which,
        // so everything asks the server again.
        invalidatePhotoCaches(queryClient);
        toast.error("That photo could not be moved to Trash.");
        return;
      }
      // The photo leaves every cached grid at once; refetching every loaded
      // page of the grid behind the viewer only delayed showing that (CODE-1).
      removePhotosFromLists(queryClient, result.photoIds);
      toast.success("Moved to Trash", {
        description: trashDisclosure,
        action: {
          label: "Undo",
          onClick: () => {
            void runPhotoAction("restore", result.photoIds)
              .then(() => { invalidatePhotoCaches(queryClient); toast.success("Photo restored"); })
              .catch((reason) => toast.error(reason instanceof Error ? reason.message : "Could not restore the photo"));
          },
        },
      });
      onTrashed?.();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not move the photo to Trash");
    } finally {
      setTrashing(false);
    }
  };
  // The grid's rows do not carry albums; the one-photo read does.
  const { data: detail, isLoading: albumsLoading } = usePhotoDetail(photo.id);
  const albums = detail?.albums ?? [];
  const actor = usePhotoActor();
  // The saved name shows at once, even before the cached rows are patched below.
  const [saved, setSaved] = useState<{ id: string; name: string | null } | null>(null);
  const name = saved?.id === photo.id ? saved.name : photoName(photo);
  // A half-typed name belongs to its photo: paging to another one drops it.
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const draft = edit?.id === photo.id ? edit.text : null;
  const setDraft = (text: string | null) => setEdit(text === null ? null : { id: photo.id, text });
  const [renaming, setRenaming] = useState(false);

  const saveName = async () => {
    if (draft === null || renaming) return;
    setRenaming(true);
    try {
      const { photo: updated } = await renamePhoto(photo.id, draft);
      setSaved({ id: photo.id, name: photoName(updated) });
      setDraft(null);
      // The server's row goes into every cached grid and open photo, so the
      // grid behind the viewer shows the name without refetching (CODE-1).
      patchPhotoRows(queryClient, [updated]);
      toast.success(draft.trim() ? "Photo renamed" : "Name set back to the automatic name");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to rename the photo");
    } finally {
      setRenaming(false);
    }
  };

  const copyLink = async () => {
    try {
      // Names the photo only, so it works with or without a project.
      await navigator.clipboard.writeText(
        buildPhotoLink(window.location.origin, photo.id)
      );
      toast.success("Link copied");
    } catch {
      // Insecure origin or permission denied — never an unhandled rejection.
      toast.error("Couldn't copy the link");
    }
  };

  const fileInfo = formatFileInfo(photo);
  const sidecarUrl = sidecarDownloadUrl(photo);
  // 'file'/'upload' dates are fallbacks (lastModified / server time), never
  // EXIF evidence — say so.
  const approxDate =
    photo.captured_at_source === "file" || photo.captured_at_source === "upload";

  return (
    // break-words: project names and 64-char tags are unconstrained text.
    <div className="flex flex-col gap-6 break-words">
      <dl className="flex flex-col gap-4">
        <div>
          <dt className={factLabel}>Name</dt>
          <dd data-testid="photo-name" className={cn(factValue, "wrap-anywhere")}>
            {draft === null ? (
              name ?? "Untitled"
            ) : (
              <form
                className="mt-1 flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveName();
                }}
              >
                <input
                  aria-label="Photo name"
                  autoFocus
                  value={draft}
                  maxLength={MAX_PHOTO_NAME_LENGTH}
                  disabled={renaming}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // Escape cancels the rename; it must not also close the viewer.
                    if (event.key === "Escape" && !renaming) {
                      event.stopPropagation();
                      setDraft(null);
                    }
                  }}
                  placeholder="Automatic name"
                  className="min-h-11 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base font-normal text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none"
                />
                <span className="text-sm font-normal text-[#b4b4b4]">
                  Leave it empty to go back to the automatic name.
                </span>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={renaming || draft.trim() === (name ?? "")}
                    className="min-h-11 rounded-lg bg-[#2680FC] px-4 text-base font-medium text-white disabled:opacity-50"
                  >
                    {renaming ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={renaming}
                    onClick={() => setDraft(null)}
                    className="min-h-11 rounded-lg px-3 text-base font-normal text-[#d0d0d0] hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>Project</dt>
          <dd data-testid="photo-project" className={factValue}>
            {photo.job ? (
              <>
                {/* The number is a quiet prefix; the text still reads "#4211 · Name". */}
                <span className="font-normal text-[#a0a0a0] tabular-nums">
                  #{photo.job.job_number} ·{" "}
                </span>
                {photo.job.name}
              </>
            ) : photo.job_id === null ? (
              NO_PROJECT
            ) : (
              "Photo"
            )}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>Albums</dt>
          <dd data-testid="photo-albums" className={factValue}>
            {albums.length > 0 ? (
              <ul className="-my-1.5 flex flex-wrap gap-x-1.5">
                {albums.map((album) => (
                  <li key={album.id}>
                    {/* The 44px target is the link; the chip inside it matches a tag's. */}
                    <Link
                      href={`/photos/albums/${album.id}`}
                      onClick={onNavigate}
                      className="group flex min-h-11 items-center rounded-full focus:outline-none"
                    >
                      <span
                        className={cn(
                          chip,
                          "text-[#8bbaff] group-hover:bg-[#444444] group-focus-visible:ring-2 group-focus-visible:ring-[#2680FC]"
                        )}
                      >
                        {album.name}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[#d0d0d0]">
                {albumsLoading ? "Loading..." : "Not in an album"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>Tags</dt>
          <dd data-testid="photo-tags" className={factValue}>
            {photo.tags.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {photo.tags.map((tag) => (
                  <li key={tag} className={cn(chip, "text-white")}>
                    {tag}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[#d0d0d0]">No tags</span>
            )}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>About this file</dt>
          <dd>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className={fileFactLabel}>Taken</dt>
              <dd className={factValue}>
                {approxDate && "Approx. "}
                {formatCapturedAt(photo.captured_at)}
              </dd>
              {photo.uploader?.full_name && (
                <>
                  <dt className={fileFactLabel}>Uploaded by</dt>
                  <dd className={factValue}>{photo.uploader.full_name}</dd>
                </>
              )}
              {photo.original_name && photo.original_name !== name && (
                <>
                  <dt className={fileFactLabel}>Uploaded as</dt>
                  <dd className={cn(factValue, "wrap-anywhere")}>{photo.original_name}</dd>
                </>
              )}
              {fileInfo && (
                <>
                  <dt className={fileFactLabel}>File</dt>
                  <dd className={factValue}>{fileInfo}</dd>
                </>
              )}
            </dl>
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        {/* Personal: only this person sees their hearts. */}
        <button type="button" onClick={() => void toggleFavorite(photo)} aria-pressed={hearted} className={action}>
          <Heart className={cn(actionIcon, hearted && "fill-[#FF4D6D] text-[#FF4D6D]")} aria-hidden="true" />
          {hearted ? "Remove from favorites" : "Add to favorites"}
        </button>
        {/* The untouched original file; see downloadUrl. */}
        <a href={downloadUrl(photo)} className={action}>
          <Download className={actionIcon} aria-hidden="true" />
          Download
        </a>
        {sidecarUrl && (
          <a href={sidecarUrl} className={action}>
            <Download className={actionIcon} aria-hidden="true" />
            Download XMP
          </a>
        )}
        <button type="button" onClick={() => setDraft(name ?? "")} className={action}>
          <TextCursorInput className={actionIcon} aria-hidden="true" />
          Rename
        </button>
        <button type="button" onClick={onEdit} className={action}>
          <Pencil className={actionIcon} aria-hidden="true" />
          Edit tags
        </button>
        <button type="button" onClick={onSetProject} className={action}>
          <Briefcase className={actionIcon} aria-hidden="true" />
          Set project
        </button>
        <button type="button" onClick={copyLink} className={action}>
          <Link2 className={actionIcon} aria-hidden="true" />
          Copy link
        </button>
      </div>

      {/* The recovery facts sit with the one action they are about. Offered only to
          whoever may use it; anyone else is told why there is no button. Nothing
          shows until the permissions have loaded. */}
      {actor && (canTrashPhoto(actor, photo) ? (
        <div className="border-t border-[#4e4e4e] pt-4">
          <button
            type="button"
            onClick={() => void moveToTrash()}
            disabled={trashing}
            className={cn(action, "text-red-200 hover:border-red-400 disabled:opacity-60")}
          >
            <Trash2 className="h-5 w-5 shrink-0 text-red-300" aria-hidden="true" />
            {trashing ? "Moving to trash..." : "Move to trash"}
          </button>
          <p className="mt-2 text-sm leading-relaxed text-[#a0a0a0]">{trashDisclosure}</p>
        </div>
      ) : (
        <p data-testid="trash-rule" className="border-t border-[#4e4e4e] pt-4 text-sm leading-relaxed text-[#a8a8a8]">
          {TRASH_RULE_MESSAGE}
        </p>
      ))}
    </div>
  );
}
