"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import { supabase } from "@/lib/supabaseClient";
import { fetchJson } from "@/lib/photos/api";
import { formatBytes } from "@/lib/photos/format";
import { downloadUrl, previewUrl, publicUrl } from "@/lib/photos/urls";
import EditPhotoSheet from "@/components/photos/edit-photo-sheet";
import type { PhotoRow } from "@/lib/photos/types";

// Zoom/swipe run on the screen-quality preview, never the original —
// "Download original" streams the untouched file. Editing opens
// EditPhotoSheet on top; the lightbox root is dropped to z-40 so the sheet
// (z-50) and its nested pickers (z-[60]) stack above it.

interface PhotoLightboxProps {
  /** Openable photos in display order (the current filtered/grouped set). */
  photos: PhotoRow[];
  open: boolean;
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
  /** Fired after a successful edit or delete so grids refetch. */
  onChanged(): void;
}

function formatCaptured(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFileInfo(photo: PhotoRow): string | null {
  const parts: string[] = [];
  const size = formatBytes(photo.original_bytes);
  if (size) parts.push(size);
  const ext = photo.original_name?.includes(".")
    ? photo.original_name.split(".").pop()
    : photo.mime_type?.split("/")[1];
  if (ext) parts.push(ext.toUpperCase());
  return parts.length > 0 ? parts.join(" ") : null;
}

export default function PhotoLightbox({
  photos,
  open,
  index,
  onIndexChange,
  onClose,
  onChanged,
}: PhotoLightboxProps) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const photo = photos[index] as PhotoRow | undefined;

  const slides = useMemo(
    () =>
      photos.map((item) =>
        item.kind === "video"
          ? {
              // Playback streams the original (storage serves range requests;
              // there's no transcode) behind the generated poster frame.
              type: "video" as const,
              poster: previewUrl(item) ?? undefined,
              controls: true,
              playsInline: true,
              preload: "none",
              sources: [
                {
                  src: publicUrl(item.original_path),
                  type: item.mime_type ?? "video/mp4",
                },
              ],
            }
          : {
              src: previewUrl(item) ?? "",
              alt: item.original_name ?? "",
            }
      ),
    [photos]
  );

  // Who am I? Delete is uploader-or-admin; hide the button otherwise (RLS
  // still enforces it server-side either way).
  const { data: me } = useQuery({
    queryKey: ["own-profile"],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return null;
      const { data } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", session.user.id)
        .single();
      return { id: session.user.id, role: data?.role ?? "employee" };
    },
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  // Leaving a slide abandons any half-done edit/confirm on it.
  useEffect(() => {
    setEditing(false);
    setConfirmingDelete(false);
  }, [index, open]);

  const canDelete =
    !!photo && !!me && (photo.uploader_id === me.id || me.role === "admin");
  const fileInfo = photo ? formatFileInfo(photo) : null;

  const deletePhoto = async () => {
    if (!photo) return;
    setBusy(true);
    try {
      await fetchJson(`/api/photos/${photo.id}`, "Delete failed", {
        method: "DELETE",
      });
      toast.success("Photo deleted");
      onChanged();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed");
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const infoBar = photo && (
    <div className="pointer-events-auto bg-gradient-to-t from-black/85 to-transparent px-4 pb-4 pt-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="text-sm font-semibold text-white">
          {photo.job ? `#${photo.job.job_number} · ${photo.job.name}` : "Photo"}
        </div>
        {(photo.sheet_number || photo.tags.length > 0) && (
          <div className="mt-0.5 text-xs text-[#d0d0d0]">
            {photo.sheet_number && (
              <span className="font-semibold text-[#2680FC]">
                Sheet {photo.sheet_number}
              </span>
            )}
            {photo.sheet_number && photo.tags.length > 0 && " · "}
            {photo.tags.join(" · ")}
          </div>
        )}
        <div className="mt-0.5 text-xs text-[#a0a0a0]">
          Taken {formatCaptured(photo.captured_at)}
          {photo.uploader?.full_name &&
            ` · Uploaded by ${photo.uploader.full_name}`}
          {fileInfo && ` · ${fileInfo}`}
        </div>
        <div className="mt-3 flex gap-2">
          <a
            href={downloadUrl(photo)}
            className="flex-1 rounded-lg bg-[#2680FC] py-2 text-center text-xs font-medium text-white hover:bg-[#1a6fd8]"
          >
            Download original
          </a>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 rounded-lg border border-[#4e4e4e] bg-[#2e2e2e]/90 py-2 text-center text-xs font-medium text-white hover:border-[#2680FC]"
          >
            Edit tags
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() =>
                confirmingDelete ? deletePhoto() : setConfirmingDelete(true)
              }
              disabled={busy}
              className={`flex-1 rounded-lg border py-2 text-center text-xs font-medium ${
                confirmingDelete
                  ? "border-red-500 bg-red-500/20 text-red-300"
                  : "border-[#4e4e4e] bg-[#2e2e2e]/90 text-red-400 hover:border-red-500"
              }`}
            >
              {confirmingDelete ? "Confirm delete?" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Lightbox
        open={open}
        close={onClose}
        index={index}
        on={{ view: ({ index: viewIndex }) => onIndexChange(viewIndex) }}
        slides={slides}
        plugins={[Zoom, Video, Counter]}
        zoom={{ maxZoomPixelRatio: 4, doubleTapDelay: 300 }}
        carousel={{ finite: false }}
        controller={{ closeOnBackdropClick: false }}
        styles={{
          // Below the edit sheet (z-50) and its nested pickers (z-[60]).
          root: { zIndex: 40 },
          container: { backgroundColor: "rgba(0,0,0,.92)" },
        }}
        render={{
          controls: () => (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
              {infoBar}
            </div>
          ),
        }}
      />
      {editing && (
        <EditPhotoSheet
          photo={photo ?? null}
          open
          onOpenChange={setEditing}
          onSaved={onChanged}
        />
      )}
    </>
  );
}
