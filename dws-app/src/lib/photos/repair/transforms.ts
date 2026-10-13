// Server-side derivative fill for images the browser did not preview: a
// HEIC picked in Chrome, a 60 MB TIFF or an 80 MB JPEG the upload client
// refused to decode, or a tab killed between the original and its
// derivatives. Two renderers:
//   - sharp, from a /tmp copy of the original, for everything libvips reads
//     (JPEG, PNG, WebP, TIFF, GIF, AVIF, SVG), with no 25 MB ceiling;
//   - Supabase's image transform endpoint for HEIC/HEIF, which the prebuilt
//     sharp cannot decode (no HEVC decoder), under its own 25 MB input cap.
// A refusal by both is permanent: the caller downgrades the row to a file tile.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { THUMB_MAX_DIM, PREVIEW_MAX_DIM } from "../derivatives";
import {
  derivedKeys,
  SERVER_IMAGE_MAX_BYTES,
  TRANSFORM_MAX_BYTES,
  TRANSFORMABLE,
  type RepairRow,
} from "./sweep";
import { WorkBudget } from "./deadline";
import { downloadOriginal, MediaProcessingLimit } from "./download";

const RENDER_MAX_BYTES = 8 * 1024 * 1024;
/** Decoded-pixel ceiling for sharp (a 100-megapixel original is ~400 MB of
 * pixels; JPEG shrinks on load so the preview never holds that much). */
const SHARP_MAX_PIXELS = 400_000_000;
/** Formats only the transform endpoint renders here. */
const TRANSFORM_ONLY = new Set(["image/heic", "image/heif"]);

export type FillResult =
  | { ok: true }
  | /** Render refused the original (unsupported/oversized after all) — the
     * caller downgrades the row to a deliberate file tile with this reason. */
    { ok: false; reason: string };

type Rendered = { body: Blob; contentType: string };
type RenderOutcome = Rendered | { status: number } | { refused: string };

/** Render the original at `width` px through Supabase. The Accept header is
 * what selects WebP output (Supabase auto-formats on Accept; an explicit
 * format param is not part of the transform API). Only incompatible input is
 * a permanent refusal; unavailable objects/services and permission or
 * configuration errors must retry. */
async function renderWithTransform(
  admin: SupabaseClient,
  originalPath: string,
  width: number,
  budget: WorkBudget,
): Promise<Rendered | { status: number }> {
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

/** libvips says this about input it will never read; anything else (out of
 * memory, a vanished temp file) is a failure of this run, so it retries. */
const unreadable = (error: unknown) =>
  error instanceof Error && /unsupported image format|corrupt header|VipsJpeg: Premature end|not a (TIFF|JPEG|PNG)|unable to load/i.test(error.message);

/** Both sizes from one /tmp copy. The longest side is scaled to `maxDim`,
 * never up; EXIF orientation is applied so a rotated phone photo is upright,
 * like the browser's `imageOrientation: "from-image"`. */
async function renderWithSharp(
  admin: SupabaseClient,
  row: Pick<RepairRow, "original_path">,
  budget: WorkBudget,
): Promise<[Rendered, Rendered] | { refused: string }> {
  budget.check();
  const dir = await mkdtemp(path.join(os.tmpdir(), "photos-derive-"));
  try {
    const input = path.join(dir, `input${path.extname(row.original_path) || ".bin"}`);
    const { data } = admin.storage.from("photos").getPublicUrl(row.original_path);
    try {
      await downloadOriginal(data.publicUrl, input, budget, SERVER_IMAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof MediaProcessingLimit) return { refused: error.message };
      throw error;
    }
    const render = (maxDim: number) => budget.run(async () => {
      const body = await sharp(input, { sequentialRead: true, limitInputPixels: SHARP_MAX_PIXELS })
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      return { body: new Blob([new Uint8Array(body)]), contentType: "image/webp" } satisfies Rendered;
    });
    try {
      return [await render(THUMB_MAX_DIM), await render(PREVIEW_MAX_DIM)];
    } catch (error) {
      if (unreadable(error)) return { refused: (error as Error).message };
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function renderBoth(
  admin: SupabaseClient,
  row: Pick<RepairRow, "original_path" | "mime_type" | "original_bytes">,
  budget: WorkBudget,
): Promise<[RenderOutcome, RenderOutcome]> {
  const mime = row.mime_type ?? "";
  const transformable = TRANSFORMABLE.has(mime) && (row.original_bytes ?? Infinity) <= TRANSFORM_MAX_BYTES;
  const transform = () => Promise.all([
    renderWithTransform(admin, row.original_path, THUMB_MAX_DIM, budget),
    renderWithTransform(admin, row.original_path, PREVIEW_MAX_DIM, budget),
  ]);
  if (TRANSFORM_ONLY.has(mime)) {
    if (!transformable) {
      const refused = { refused: `${mime} over ${TRANSFORM_MAX_BYTES} bytes` };
      return [refused, refused];
    }
    return transform();
  }
  const own = await renderWithSharp(admin, row, budget);
  if (Array.isArray(own)) return own;
  // sharp could not read it; the transform endpoint may still (a HEIC saved
  // with a .jpg name, say). Otherwise sharp's reason stands.
  if (transformable) return transform();
  return [own, own];
}

export async function fillImageDerivatives(
  admin: SupabaseClient,
  row: Pick<RepairRow, "id" | "uploader_id" | "original_path" | "mime_type" | "original_bytes">,
  budget = new WorkBudget(),
): Promise<FillResult> {
  const paths = derivedKeys(row.uploader_id, row.id);

  const [thumb, preview] = await renderBoth(admin, row, budget);
  for (const rendered of [thumb, preview]) {
    if ("status" in rendered) return { ok: false, reason: `render ${rendered.status}` };
    if ("refused" in rendered) return { ok: false, reason: rendered.refused };
  }

  const uploads = await Promise.allSettled(([
    [paths.thumb, thumb as Rendered],
    [paths.preview, preview as Rendered],
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
