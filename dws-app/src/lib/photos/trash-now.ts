import { fetchJson } from "./api";
import { inChunks, MAX_ACTION_RUN_PHOTOS } from "./chunks";

// Trash (and its Undo, restore) without the confirm page. The server runs the
// whole batch (create, materialize, approve, apply) in one request per slice
// of MAX_ACTION_RUN_PHOTOS (POST /api/photos/bulk), so a 5,000-photo trash is
// five requests instead of about 150. A photo the rule refuses (someone
// else's, or older than 30 days) is left out rather than asked about, and
// counted so the toast can say so.

export interface PhotoActionResult {
  /** The photos the action reached. */
  photoIds: string[];
  /** Selected photos left out: gone, or the rule refused them. */
  leftOut: number;
  /** Photos someone else changed before this could apply to them. */
  failed: number;
}

interface BulkAnswer {
  photo_ids: string[];
  left_out: number;
  failed: number;
}

/**
 * Trash or restore `photoIds`, a slice per request. `onProgress` gets the ids
 * sent so far after each slice. A failure after the first slice is a
 * PartialBulkError: the slices before it are done.
 */
export async function runPhotoAction(
  action: "trash" | "restore",
  photoIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<PhotoActionResult> {
  const answers = await inChunks(
    photoIds,
    (chunk) =>
      fetchJson<BulkAnswer>("/api/photos/bulk", "Photo action failed", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, photo_ids: chunk }),
      }),
    onProgress,
    MAX_ACTION_RUN_PHOTOS
  );
  return {
    photoIds: answers.flatMap((answer) => answer.photo_ids),
    leftOut: answers.reduce((sum, answer) => sum + answer.left_out, 0),
    failed: answers.reduce((sum, answer) => sum + answer.failed, 0),
  };
}
