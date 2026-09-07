// Server-side derivative fill for images the browser could not decode — a HEIC
// picked in Chrome, or a tab killed between the original and its derivatives.
import type { SupabaseClient } from "@supabase/supabase-js";
import { THUMB_MAX_DIM, PREVIEW_MAX_DIM } from "../derivatives";
import { derivedKeys, type RepairRow } from "./sweep";
import { WorkBudget } from "./deadline";

const RENDER_MAX_BYTES = 8 * 1024 * 1024;

export type FillResult =
  | { ok: true }
  | /** Render refused the original (unsupported/oversized after all) — the
     * caller downgrades the row to a deliberate file tile with this reason. */
    { ok: false; reason: string };

/** Render the original at `width` px. The Accept header is what selects WebP
 * output (Supabase auto-formats on Accept; an explicit format param is not
 * part of the transform API). Only incompatible input is a permanent refusal;
 * unavailable objects/services and permission/configuration errors must retry. */
async function render(
  admin: SupabaseClient,
  originalPath: string,
  width: number,
  budget: WorkBudget,
): Promise<{ body: Blob; contentType: string } | { status: number }> {
  const { data } = admin.storage.from("photos").getPublicUrl(originalPath, {
    transform: { width, resize: "contain", quality: 80 },
  });
  return budget.run(async (signal) => {
    const res = await fetch(data.publicUrl, {
      headers: { Accept: "image/webp" },
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if ([400, 413, 415, 422].includes(res.status)) return { status: res.status };
      throw new Error(`render ${res.status}`);
    }
    if (!res.body) throw new Error("render response has no body");
    const reader = res.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RENDER_MAX_BYTES) throw new Error(`render exceeds ${RENDER_MAX_BYTES} bytes`);
        parts.push(new Uint8Array(value));
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel();
    }
    return {
      body: new Blob(parts),
      contentType: res.headers.get("content-type") ?? "image/webp",
    };
  });
}

export async function fillImageDerivatives(
  admin: SupabaseClient,
  row: Pick<RepairRow, "id" | "uploader_id" | "original_path">,
  budget = new WorkBudget(),
): Promise<FillResult> {
  const paths = derivedKeys(row.uploader_id, row.id);

  const [thumb, preview] = await Promise.all([
    render(admin, row.original_path, THUMB_MAX_DIM, budget),
    render(admin, row.original_path, PREVIEW_MAX_DIM, budget),
  ]);
  if ("status" in thumb) return { ok: false, reason: `render ${thumb.status}` };
  if ("status" in preview)
    return { ok: false, reason: `render ${preview.status}` };

  const uploads = await Promise.allSettled(([
    [paths.thumb, thumb],
    [paths.preview, preview],
  ] as const).map(async ([path, rendered]) => {
    const { error } = await budget.run(() => admin.storage
      .from("photos")
      .upload(path, rendered.body, {
        contentType: rendered.contentType,
        upsert: true,
      }));
    if (error) throw new Error(`upload ${path}: ${error.message}`);
  }));
  for (const result of uploads) {
    if (result.status === "rejected") throw result.reason;
  }

  const { data: changed, error } = await budget.run((signal) => admin
    .from("photos")
    .update({ thumb_path: paths.thumb, preview_path: paths.preview })
    .eq("id", row.id).is("deleted_at", null).select("id").abortSignal(signal).maybeSingle());
  if (error) throw new Error(`update ${row.id}: ${error.message}`);
  if (!changed) throw new Error("photo no longer active");
  return { ok: true };
}
