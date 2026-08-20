"use client";

import { Download, FileText, Video } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import type { PhotoRow } from "@/lib/photos/types";

// Date-grouped photo grid (newest first). Every tile carries a
// Download-original control: a Supabase `?download=<original_name>` URL —
// a bare <a download> attribute is ignored cross-origin, so the
// Content-Disposition header (which Supabase sets from ?download=) is what
// makes iPhones save the exact original with its real filename.

function publicUrl(path: string): string {
  return supabase.storage.from("photos").getPublicUrl(path).data.publicUrl;
}

export function downloadUrl(photo: PhotoRow): string {
  const { data } = supabase.storage
    .from("photos")
    .getPublicUrl(photo.original_path, {
      download: photo.original_name || true,
    });
  return data.publicUrl;
}

export interface PhotoGroup {
  label: string;
  photos: PhotoRow[];
}

/** Group photos (already sorted newest-first) by local capture date. */
export function groupPhotosByDate(photos: PhotoRow[]): PhotoGroup[] {
  const groups: PhotoGroup[] = [];
  let currentKey: string | null = null;
  for (const photo of photos) {
    const date = new Date(photo.captured_at);
    const key = Number.isNaN(date.getTime())
      ? "Unknown date"
      : date.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
    if (key !== currentKey) {
      groups.push({ label: key, photos: [] });
      currentKey = key;
    }
    groups[groups.length - 1].photos.push(photo);
  }
  return groups;
}

function Tile({ photo }: { photo: PhotoRow }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-md bg-[#2e2e2e]">
      {photo.thumb_path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={publicUrl(photo.thumb_path)}
          alt={photo.original_name ?? ""}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 border border-[#4e4e4e] px-2 text-center">
          {photo.kind === "video" ? (
            <Video className="h-5 w-5 text-[#a0a0a0]" />
          ) : (
            <FileText className="h-5 w-5 text-[#a0a0a0]" />
          )}
          <span className="w-full truncate text-[10px] text-[#a0a0a0]">
            {photo.original_name ?? photo.kind}
          </span>
        </div>
      )}
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

export default function PhotoGrid({ photos }: { photos: PhotoRow[] }) {
  const groups = groupPhotosByDate(photos);

  return (
    <div>
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="mb-1.5 mt-3 text-xs text-[#a0a0a0]">{group.label}</h2>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5">
            {group.photos.map((photo) => (
              <Tile key={photo.id} photo={photo} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
