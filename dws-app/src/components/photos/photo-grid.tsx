"use client";

import { Download, FileText, Video } from "lucide-react";
import { groupPhotos, type GroupBy } from "@/lib/photos/group";
import { downloadUrl, isOpenable, publicUrl } from "@/lib/photos/urls";
import type { PhotoRow } from "@/lib/photos/types";

// The one photo grid every view shares: grouped sections (date / sheet / job),
// image tiles that open the lightbox, and labeled file tiles (name + download)
// for uploads that can't render — odd formats never show as holes.

interface PhotoGridProps {
  photos: PhotoRow[];
  groupBy?: GroupBy;
  /** Tapping an image tile — the page opens the lightbox at this photo. */
  onOpenPhoto?: (photo: PhotoRow) => void;
  /**
   * Display rule, not a special flag: when set (e.g. "professional") and
   * grouping by date, photos carrying the tag get a pinned section on top.
   */
  pinnedTag?: string;
  pinnedLabel?: string;
  /** Tapping the pinned header — the page filters to the pinned tag. */
  onExpandPinned?: () => void;
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function Tile({
  photo,
  onOpen,
}: {
  photo: PhotoRow;
  onOpen?: (photo: PhotoRow) => void;
}) {
  if (isOpenable(photo) && photo.thumb_path) {
    return (
      <button
        type="button"
        onClick={() => onOpen?.(photo)}
        className="group relative aspect-square overflow-hidden rounded-md bg-[#2e2e2e] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={publicUrl(photo.thumb_path)}
          alt={photo.original_name ?? ""}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </button>
    );
  }

  // Labeled file tile: video (until Phase 4 playback) or a non-displayable
  // companion file (XMP sidecar, RAW) — named, sized, downloadable.
  const size = formatBytes(photo.original_bytes);
  return (
    <div className="relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-[#4e4e4e] bg-[#2e2e2e] px-2 text-center">
      {photo.kind === "video" ? (
        <Video className="h-5 w-5 text-[#a0a0a0]" />
      ) : (
        <FileText className="h-5 w-5 text-[#a0a0a0]" />
      )}
      <span className="w-full truncate text-[10px] text-[#a0a0a0]">
        {photo.original_name ?? photo.kind}
      </span>
      {size && <span className="text-[9px] text-[#7e7e7e]">{size}</span>}
      <a
        href={downloadUrl(photo)}
        aria-label={`Download ${photo.original_name ?? "original"}`}
        className="absolute bottom-1 right-1 rounded-md bg-black/60 p-1.5 text-white hover:bg-[#2680FC]"
      >
        <Download className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function TileGrid({
  photos,
  onOpen,
}: {
  photos: PhotoRow[];
  onOpen?: (photo: PhotoRow) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5">
      {photos.map((photo) => (
        <Tile key={photo.id} photo={photo} onOpen={onOpen} />
      ))}
    </div>
  );
}

export default function PhotoGrid({
  photos,
  groupBy = "date",
  onOpenPhoto,
  pinnedTag,
  pinnedLabel,
  onExpandPinned,
}: PhotoGridProps) {
  const pinned =
    pinnedTag && groupBy === "date"
      ? photos.filter((photo) => photo.tags.includes(pinnedTag))
      : [];
  const groups = groupPhotos(photos, groupBy);

  return (
    <div>
      {pinned.length > 0 && (
        <section>
          <button
            type="button"
            onClick={onExpandPinned}
            className="mb-1.5 mt-3 block text-xs font-semibold text-[#2680FC] hover:text-[#1a6fd8]"
          >
            {pinnedLabel ?? pinnedTag} · {pinned.length} ›
          </button>
          <TileGrid photos={pinned.slice(0, 3)} onOpen={onOpenPhoto} />
        </section>
      )}
      {groups.map((group) => (
        <section key={group.key}>
          <h2 className="mb-1.5 mt-3 text-xs text-[#a0a0a0]">
            {group.label}
            {groupBy !== "date" && (
              <span className="text-[#7e7e7e]">
                {" "}
                · {group.photos.length}{" "}
                {group.photos.length === 1 ? "photo" : "photos"}
              </span>
            )}
          </h2>
          <TileGrid photos={group.photos} onOpen={onOpenPhoto} />
        </section>
      ))}
    </div>
  );
}
