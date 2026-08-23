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

/** Download link for the attached XMP sidecar; null when there is none. */
export function sidecarDownloadUrl(photo: PhotoRow): string | null {
  if (!photo.sidecar_path) return null;
  const { data } = supabase.storage
    .from("photos")
    .getPublicUrl(photo.sidecar_path, {
      download: photo.sidecar_name || true,
    });
  return data.publicUrl;
}

/** The lightbox renders previews only — never originals (videos stream the
 * original for playback; there's no transcode, but the poster is a preview). */
export function previewUrl(photo: PhotoRow): string | null {
  const path = photo.preview_path ?? photo.thumb_path;
  return path ? publicUrl(path) : null;
}
