// Public-URL helpers for the photos bucket (client-side).
//
// Download original uses Supabase's `?download=<original_name>` parameter —
// it sets Content-Disposition: attachment server-side, which is what makes
// iPhones save the exact original with its real filename (a bare <a download>
// attribute is ignored cross-origin, and every original lives on supabase.co,
// not the app domain).

import { supabase } from "@/lib/supabaseClient";
import type { PhotoRow } from "./types";

export function publicUrl(path: string): string {
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

/** The lightbox renders previews only — never originals. */
export function previewUrl(photo: PhotoRow): string | null {
  const path = photo.preview_path ?? photo.thumb_path;
  return path ? publicUrl(path) : null;
}

/** Can this photo open in the lightbox? (Videos wait for Phase 4 playback.) */
export function isOpenable(photo: PhotoRow): boolean {
  return photo.kind === "image" && Boolean(photo.preview_path ?? photo.thumb_path);
}
