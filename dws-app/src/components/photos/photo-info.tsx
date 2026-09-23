"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Download, Link2, Pencil, TextCursorInput, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { invalidatePhotoCaches, renamePhoto, usePhotoDetail } from "@/lib/photos/api";
import { MAX_PHOTO_NAME_LENGTH } from "@/lib/photos/apiShared";
import { buildPhotoLink } from "@/lib/photos/photo-link";
import { trashDisclosure } from "@/lib/photos/action-client";
import {
  formatCapturedAt,
  formatFileInfo,
  jobLabel,
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
  /** Opens "Edit details" (owned by the lightbox, so it stacks above it). */
  onEdit(): void;
  /** Opens "Set project". */
  onSetProject(): void;
  /** A link inside is about to leave the viewer (an album, the confirm page). */
  onNavigate?(): void;
}

const factLabel = "text-sm text-[#a8a8a8]";
const action =
  "flex min-h-11 w-full items-center gap-3 rounded-lg border border-[#4e4e4e] bg-[#3a3a3a] px-3 text-base text-white hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]";
const actionIcon = "h-5 w-5 shrink-0 text-[#b4b4b4]";

export default function PhotoInfo({ photo, onEdit, onSetProject, onNavigate }: PhotoInfoProps) {
  const queryClient = useQueryClient();
  // The grid's rows do not carry albums; the one-photo read does.
  const { data: detail, isLoading: albumsLoading } = usePhotoDetail(photo.id);
  const albums = detail?.albums ?? [];
  // The saved name shows at once; the grid row catches up when its list refetches.
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
      invalidatePhotoCaches(queryClient);
      toast.success(draft.trim() ? "Photo renamed" : "Name set back to the uploaded filename");
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
  const capturedPrefix =
    photo.captured_at_source === "file" || photo.captured_at_source === "upload"
      ? "Approx."
      : "Taken";

  return (
    // break-words: project names and 64-char tags are unconstrained text.
    <div className="flex flex-col gap-4 break-words">
      <dl className="space-y-2.5">
        <div>
          <dt className={factLabel}>Name</dt>
          <dd data-testid="photo-name" className="break-all text-base font-semibold text-white">
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
                  placeholder={photo.original_name ?? "Photo name"}
                  className="min-h-11 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base font-normal text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none"
                />
                <span className="text-sm font-normal text-[#b4b4b4]">
                  Leave it empty to go back to the uploaded filename.
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
          <dd data-testid="photo-project" className="text-base font-semibold text-white">
            {photo.job
              ? jobLabel(photo.job)
              : photo.job_id === null
                ? NO_PROJECT
                : "Photo"}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>Albums</dt>
          <dd data-testid="photo-albums" className="text-base text-white">
            {albums.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {albums.map((album) => (
                  <li key={album.id}>
                    <Link
                      href={`/photos/albums/${album.id}`}
                      onClick={onNavigate}
                      className="flex min-h-11 items-center rounded-full border border-[#4e4e4e] bg-[#3a3a3a] px-3 text-base text-[#8bbaff] hover:border-[#2680FC]"
                    >
                      {album.name}
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
          <dd data-testid="photo-tags" className="text-base text-[#d0d0d0]">
            {photo.tags.length > 0 ? photo.tags.join(" · ") : "No tags"}
          </dd>
        </div>
        <div>
          <dt className={factLabel}>About this file</dt>
          <dd className="space-y-0.5 text-base text-[#d0d0d0]">
            <div>
              {capturedPrefix} {formatCapturedAt(photo.captured_at)}
            </div>
            {photo.uploader?.full_name && <div>Uploaded by {photo.uploader.full_name}</div>}
            {(photo.original_name || fileInfo) && (
              <div className="break-words">
                {[
                  name !== photo.original_name && photo.original_name
                    ? `Uploaded as ${photo.original_name}`
                    : photo.original_name,
                  fileInfo,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <a
          href={downloadUrl(photo)}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#2680FC] px-3 text-base font-medium text-white hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Download className="h-5 w-5" aria-hidden="true" />
          Download original
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
          Edit details
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

      {/* The recovery facts sit with the one action they are about. */}
      <div className="border-t border-[#4e4e4e] pt-4">
        <Link
          href={`/photos/actions?action=trash&photo=${encodeURIComponent(photo.id)}`}
          onClick={onNavigate}
          className={cn(action, "text-red-200 hover:border-red-400")}
        >
          <Trash2 className="h-5 w-5 shrink-0 text-red-300" aria-hidden="true" />
          Move to trash
        </Link>
        <p className="mt-2 text-base leading-relaxed text-[#b4b4b4]">{trashDisclosure}</p>
      </div>
    </div>
  );
}
