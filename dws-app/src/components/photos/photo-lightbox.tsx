"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import { supabase } from "@/lib/supabaseClient";
import { fetchJobs } from "@/lib/photos/api";
import { formatBytes } from "@/lib/photos/format";
import { downloadUrl, previewUrl, publicUrl } from "@/lib/photos/urls";
import TagInput from "@/components/photos/tag-input";
import type { PhotoRow } from "@/lib/photos/types";

// Zoom/swipe run on the screen-quality preview, never the original —
// "Download original" streams the untouched file.

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

  // Edit form state (seeded from the current photo when editing starts).
  const [editJobId, setEditJobId] = useState("");
  const [editSheet, setEditSheet] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

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

  const { data: jobs } = useQuery({
    queryKey: ["photo-jobs", ""],
    queryFn: () => fetchJobs(),
    enabled: open && editing,
  });

  // Leaving a slide abandons any half-done edit/confirm on it.
  useEffect(() => {
    setEditing(false);
    setConfirmingDelete(false);
  }, [index, open]);

  const canDelete =
    !!photo && !!me && (photo.uploader_id === me.id || me.role === "admin");
  const fileInfo = photo ? formatFileInfo(photo) : null;

  const startEditing = () => {
    if (!photo) return;
    setEditJobId(photo.job_id);
    setEditSheet(photo.sheet_number ?? "");
    setEditTags(photo.tags);
    setTagInput("");
    setEditing(true);
  };

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (tag && !editTags.includes(tag)) {
      setEditTags((previous) => [...previous, tag]);
    }
    setTagInput("");
  };

  const saveEdits = async () => {
    if (!photo) return;
    setBusy(true);
    try {
      const tags = tagInput.trim() ? [...editTags, tagInput.trim()] : editTags;
      const response = await fetch(`/api/photos/${photo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: editJobId,
          sheet_number: editSheet.trim() || null,
          tags,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Saving failed (${response.status})`);
      }
      toast.success("Photo updated");
      setEditing(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Saving failed");
    } finally {
      setBusy(false);
    }
  };

  const deletePhoto = async () => {
    if (!photo) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/photos/${photo.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Delete failed (${response.status})`);
      }
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

  const infoBar = photo && !editing && (
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
            onClick={startEditing}
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

  const editPanel = photo && editing && (
    <div className="pointer-events-auto bg-gradient-to-t from-black/95 via-black/85 to-transparent px-4 pb-4 pt-12">
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-[#4e4e4e] bg-[#2e2e2e] p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Edit photo</span>
          <button
            type="button"
            aria-label="Cancel editing"
            onClick={() => setEditing(false)}
            disabled={busy}
          >
            <X className="h-4 w-4 text-[#a0a0a0]" />
          </button>
        </div>

        <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
        <select
          value={editJobId}
          onChange={(event) => setEditJobId(event.target.value)}
          disabled={busy}
          className="mb-3 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white focus:border-[#2680FC] focus:outline-none"
        >
          {(jobs ?? []).map((job) => (
            <option key={job.id} value={job.id}>
              #{job.job_number} · {job.name}
            </option>
          ))}
          {jobs && !jobs.some((job) => job.id === editJobId) && (
            <option value={editJobId}>Current job</option>
          )}
        </select>

        <label className="mb-1.5 block text-xs text-[#a0a0a0]">
          Sheet # (optional)
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={editSheet}
          onChange={(event) => setEditSheet(event.target.value)}
          placeholder="e.g. 12"
          disabled={busy}
          className="mb-3 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
        />

        <label className="mb-1.5 block text-xs text-[#a0a0a0]">Tags</label>
        <TagInput
          className="mb-3"
          tags={editTags}
          input={tagInput}
          onInputChange={setTagInput}
          onAdd={addTag}
          onRemove={(tag) =>
            setEditTags((previous) => previous.filter((t) => t !== tag))
          }
          disabled={busy}
        />

        <button
          type="button"
          onClick={saveEdits}
          disabled={busy}
          className="w-full rounded-lg bg-[#2680FC] py-2.5 text-sm font-medium text-white hover:bg-[#1a6fd8] disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );

  return (
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
        container: { backgroundColor: "rgba(0,0,0,.92)" },
      }}
      render={{
        controls: () => (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
            {infoBar}
            {editPanel}
          </div>
        ),
      }}
    />
  );
}
