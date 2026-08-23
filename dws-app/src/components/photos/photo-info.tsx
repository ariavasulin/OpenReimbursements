"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/photos/api";
import { buildPhotoLink } from "@/lib/photos/photo-link";
import {
  formatCapturedAt,
  formatFileInfo,
  jobLabel,
} from "@/lib/photos/format";
import { downloadUrl, sidecarDownloadUrl } from "@/lib/photos/urls";
import type { PhotoRow } from "@/lib/photos/types";

interface PhotoInfoProps {
  photo: PhotoRow;
  /** "bar" = today's bottom gradient overlay; "panel" = 320px desktop column. */
  layout: "bar" | "panel";
  canDelete: boolean;
  /** Opens the edit sheet (owned by the lightbox, so it stacks above it). */
  onEdit(): void;
  onDeleted(): void;
}

export default function PhotoInfo({
  photo,
  layout,
  canDelete,
  onEdit,
  onDeleted,
}: PhotoInfoProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // Leaving a slide abandons any half-done confirm on it.
  useEffect(() => {
    setConfirmingDelete(false);
  }, [photo.id]);

  const deletePhoto = async () => {
    setBusy(true);
    try {
      await fetchJson(`/api/photos/${photo.id}`, "Delete failed", {
        method: "DELETE",
      });
      toast.success("Photo deleted");
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed");
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!photo.job) return;
    try {
      await navigator.clipboard.writeText(
        buildPhotoLink(window.location.origin, photo.job.id, photo.id)
      );
      toast.success("Link copied");
    } catch {
      // Insecure origin or permission denied — never an unhandled
      // rejection.
      toast.error("Couldn't copy the link");
    }
  };

  const handleDeleteClick = () =>
    confirmingDelete ? deletePhoto() : setConfirmingDelete(true);

  // The armed confirm is its own layer: Escape backs out of it, and must not
  // reach the desktop panel's handler, which would close the whole viewer.
  const handleDeleteKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || !confirmingDelete) return;
    event.stopPropagation();
    setConfirmingDelete(false);
  };

  const bar = layout === "bar";
  const fileInfo = formatFileInfo(photo);
  const sidecarUrl = sidecarDownloadUrl(photo);
  // 'file'/'upload' dates are fallbacks (lastModified / server time), never
  // EXIF evidence — say so.
  const capturedPrefix =
    photo.captured_at_source === "file" || photo.captured_at_source === "upload"
      ? "Approx."
      : "Taken";
  const captureMeta = [
    `${capturedPrefix} ${formatCapturedAt(photo.captured_at)}`,
    photo.uploader?.full_name && `Uploaded by ${photo.uploader.full_name}`,
    fileInfo,
  ].filter((line): line is string => Boolean(line));

  // Per-layout differences are class strings: the bar is a full-width gradient
  // overlay, the panel is a stacked column (its wrapper is `contents` so
  // header and actions stay its flex children).
  const outerClass = bar
    ? "pointer-events-auto bg-gradient-to-t from-black/85 to-transparent px-4 pb-4 pt-10"
    : // break-words: job names, sheet numbers and 64-char tags are unconstrained
      // text inside a fixed 320px column.
      "flex flex-col gap-4 break-words p-4";
  const innerClass = bar ? "mx-auto w-full max-w-3xl" : "contents";
  const actionClass = bar ? "flex-1 " : "";
  // #3e3e3e, not a fourth near-identical grey: it is the raised-surface value
  // the sheet's own fields use.
  const secondaryBg = bar ? "bg-[#2e2e2e]/90" : "bg-[#3e3e3e]";

  return (
    <div className={outerClass}>
      <div className={innerClass}>
          <div>
            <div className="text-sm font-semibold text-white">
              {photo.job ? jobLabel(photo.job) : "Photo"}
            </div>
            {(photo.sheet_number || photo.tags.length > 0) && (
              <div
                className={
                  bar
                    ? "mt-0.5 text-xs text-[#d0d0d0]"
                    : "mt-1 text-xs text-[#d0d0d0]"
                }
              >
                {photo.sheet_number && (
                  <span className="font-semibold text-[#2680FC]">
                    Sheet {photo.sheet_number}
                  </span>
                )}
                {photo.sheet_number && photo.tags.length > 0 && " · "}
                {photo.tags.join(" · ")}
              </div>
            )}
            <div
              className={
                bar
                  ? "mt-0.5 text-xs text-[#a0a0a0]"
                  : "mt-2 space-y-0.5 text-xs text-[#a0a0a0]"
              }
            >
              {bar
                ? captureMeta.join(" · ")
                : captureMeta.map((line) => <div key={line}>{line}</div>)}
            </div>
          </div>

        <div
          className={
            bar ? "mt-3 grid grid-cols-2 gap-2 sm:flex" : "flex flex-col gap-2"
          }
        >
            <a
              href={downloadUrl(photo)}
              className={`${actionClass}rounded-lg bg-[#2680FC] py-2 text-center text-xs font-medium text-white hover:bg-[#1a6fd8]`}
            >
              Download original
            </a>
            {sidecarUrl && (
              <a
                href={sidecarUrl}
                className={`${actionClass}rounded-lg border border-[#4e4e4e] ${secondaryBg} py-2 text-center text-xs font-medium text-white hover:border-[#2680FC]`}
              >
                Download XMP
              </a>
            )}
            <button
              type="button"
              onClick={onEdit}
              className={`${actionClass}rounded-lg border border-[#4e4e4e] ${secondaryBg} py-2 text-center text-xs font-medium text-white hover:border-[#2680FC]`}
            >
              Edit tags
            </button>
            <button
              type="button"
              disabled={!photo.job}
              onClick={copyLink}
              className={`${actionClass}rounded-lg border border-[#4e4e4e] ${secondaryBg} py-2 text-center text-xs font-medium text-white hover:border-[#2680FC] disabled:opacity-60`}
            >
              Copy link
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={handleDeleteClick}
                onKeyDown={handleDeleteKeyDown}
                disabled={busy}
                className={`${actionClass}rounded-lg border py-2 text-center text-xs font-medium ${
                  confirmingDelete
                    ? "border-red-500 bg-red-500/20 text-red-300"
                    : // red-400 is 3.87:1 on the panel's #3e3e3e; red-300 is 5.64:1.
                      `border-[#4e4e4e] ${secondaryBg} text-red-300 hover:border-red-500`
                }`}
              >
                {confirmingDelete ? "Confirm delete?" : "Delete"}
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
