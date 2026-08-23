// Server-side derivative fill for images the browser could not decode — a HEIC
// picked in Chrome, or a tab killed between the original and its derivatives.
import type { SupabaseClient } from "@supabase/supabase-js";
import { THUMB_MAX_DIM, PREVIEW_MAX_DIM } from "../derivatives";
import type { RepairRow } from "./sweep";

export type FillResult =
  | { ok: true }
  | /** Render refused the original (unsupported/oversized after all) — the
     * caller downgrades the row to a deliberate file tile with this reason. */
    { ok: false; reason: string };

/** Render the original at `width` px. The Accept header is what selects WebP
 * output (Supabase auto-formats on Accept; an explicit format param is not
 * part of the transform API). Non-2xx resolves null with the status. */
async function render(
  admin: SupabaseClient,
  originalPath: string,
  width: number
): Promise<{ body: Blob; contentType: string } | { status: number }> {
  const { data } = admin.storage.from("photos").getPublicUrl(originalPath, {
    transform: { width, resize: "contain", quality: 80 },
  });
  const res = await fetch(data.publicUrl, {
    headers: { Accept: "image/webp" },
  });
  if (!res.ok) return { status: res.status };
  return {
    body: await res.blob(),
    contentType: res.headers.get("content-type") ?? "image/webp",
  };
}

export async function fillImageDerivatives(
  admin: SupabaseClient,
  row: Pick<RepairRow, "id" | "uploader_id" | "original_path">
): Promise<FillResult> {
  // Same derived/ keys the client's storagePaths() builds — spelled out here
  // so the server bundle doesn't drag in the tus-js-client upload module.
  const paths = {
    thumb: `derived/${row.uploader_id}/${row.id}_thumb.webp`,
    preview: `derived/${row.uploader_id}/${row.id}_preview.webp`,
  };

  const [thumb, preview] = await Promise.all([
    render(admin, row.original_path, THUMB_MAX_DIM),
    render(admin, row.original_path, PREVIEW_MAX_DIM),
  ]);
  if ("status" in thumb) return { ok: false, reason: `render ${thumb.status}` };
  if ("status" in preview)
    return { ok: false, reason: `render ${preview.status}` };

  for (const [path, rendered] of [
    [paths.thumb, thumb],
    [paths.preview, preview],
  ] as const) {
    const { error } = await admin.storage
      .from("photos")
      .upload(path, rendered.body, {
        contentType: rendered.contentType,
        upsert: true,
      });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
  }

  const { error } = await admin
    .from("photos")
    .update({ thumb_path: paths.thumb, preview_path: paths.preview })
    .eq("id", row.id);
  if (error) throw new Error(`update ${row.id}: ${error.message}`);
  return { ok: true };
}
