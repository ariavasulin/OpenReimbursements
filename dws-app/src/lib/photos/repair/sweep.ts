// Pure repair planner: photos rows + storage listing in, actions out. The
// route (app/api/photos/repair/route.ts) fetches state and executes; this
// module never touches the network, so the convergence rules are testable
// with plain objects. Re-running an applied plan yields [] — idempotence is
// what makes the daily cron and manual runs safely overlappable.

/** The columns the sweep needs from a photos row with a hole. playback_*
 * stay optional so plain test rows and callers that don't select them
 * still typecheck; absent reads as "no rendition, nothing skipped". */
export interface RepairRow {
  id: string;
  uploader_id: string;
  kind: "image" | "video" | "file";
  mime_type: string | null;
  original_path: string;
  original_bytes: number | null;
  thumb_path: string | null;
  playback_path?: string | null;
  playback_skipped_reason?: string | null;
  created_at: string;
}

/** One object found under originals/ in the photos bucket. */
export interface StoredObject {
  name: string;
  created_at: string;
  /** True when some photos row points at it (original_path or sidecar_path). */
  has_row: boolean;
}

export type Action =
  | { action: "fillImageDerivatives"; photoId: string }
  | { action: "markFileTile"; photoId: string; reason: string }
  | { action: "makeVideoPoster"; photoId: string }
  /** Phase 6 — planned only when opts.transcode is on. */
  | { action: "transcodeVideo"; photoId: string }
  | { action: "deleteOrphanObject"; path: string }
  | { action: "deleteDeadRow"; photoId: string };

/** Formats Supabase's image transform endpoint can render. */
export const TRANSFORMABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/avif",
]);
/** Transform endpoint input cap (Supabase: 25 MB). */
export const TRANSFORM_MAX_BYTES = 25 * 1024 * 1024;
/** Rows younger than this are skipped — the client may still be uploading
 * derivatives right behind the original. */
export const SETTLE_MS = 10 * 60 * 1000;
/** Row-less objects younger than this are left alone — a TUS upload can
 * legitimately take hours, and its finalize lands only at the end. */
export const ORPHAN_MS = 24 * 60 * 60 * 1000;

export interface SweepOpts {
  /** Phase 6 gate (PHOTOS_TRANSCODE=1). Off: transcodeVideo is never planned. */
  transcode?: boolean;
  /** Orphan age override for drills (?olderThan=0 on a manual POST). */
  orphanMs?: number;
}

export function planSweep(
  rows: RepairRow[],
  objects: StoredObject[],
  existingOriginals: Set<string>,
  now: number,
  opts: SweepOpts = {}
): Action[] {
  const orphanMs = opts.orphanMs ?? ORPHAN_MS;
  const out: Action[] = [];
  for (const r of rows) {
    const age = now - Date.parse(r.created_at);
    if (age < SETTLE_MS) continue; // client may still be uploading derivatives
    if (!existingOriginals.has(r.original_path)) {
      // Finalize raced a dead upload: a row whose original never landed.
      out.push({ action: "deleteDeadRow", photoId: r.id });
      continue;
    }
    if (r.thumb_path == null) {
      if (r.kind === "image") {
        const ok =
          TRANSFORMABLE.has(r.mime_type ?? "") &&
          (r.original_bytes ?? Infinity) <= TRANSFORM_MAX_BYTES;
        out.push(
          ok
            ? { action: "fillImageDerivatives", photoId: r.id }
            : { action: "markFileTile", photoId: r.id, reason: "not transformable" }
        );
      } else if (r.kind === "video") {
        out.push({ action: "makeVideoPoster", photoId: r.id });
      }
      // kind 'file': a deliberate file tile — no derivatives, no action.
    }
    if (
      opts.transcode &&
      r.kind === "video" &&
      r.playback_path == null &&
      !r.playback_skipped_reason
    ) {
      out.push({ action: "transcodeVideo", photoId: r.id });
    }
  }
  for (const o of objects) {
    if (!o.has_row && now - Date.parse(o.created_at) > orphanMs) {
      out.push({ action: "deleteOrphanObject", path: o.name });
    }
  }
  return out;
}
