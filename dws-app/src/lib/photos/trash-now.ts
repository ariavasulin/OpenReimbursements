import { actionRequest } from "./action-client";

// Trash (and its Undo, restore) without the confirm page: the same batch the
// page drives — create, materialize, approve, apply — run to the end here. A
// photo the rule refuses (someone else's, or older than 30 days) is left out
// rather than asked about, and counted so the toast can say so.

interface BatchView {
  batch: { id: string; materialization_complete: boolean };
  total: number;
  items: { photo_id: string; status: string }[];
  unresolved: { reference_index: number }[];
}

const PAGE = 100;

export interface PhotoActionResult {
  /** The photos the action reached. */
  photoIds: string[];
  /** Selected photos the rule refused. */
  leftOut: number;
}

export async function runPhotoAction(action: "trash" | "restore", photoIds: string[]): Promise<PhotoActionResult> {
  const created = await actionRequest<{ batch: { id: string } }>("batches", {
    action,
    selector: { photos: photoIds.map((photo_id) => ({ photo_id })) },
  });
  const id = created.batch.id;
  let view: BatchView;
  let leftOut = 0;
  let choices: Record<number, null> | undefined;
  do {
    view = await actionRequest<BatchView>(`batches/${id}/materialize`, choices ? { choices } : {});
    choices = undefined;
    if (view.unresolved.length > 0) {
      choices = Object.fromEntries(view.unresolved.map((item) => [item.reference_index, null]));
      leftOut += view.unresolved.length;
    }
  } while (!view.batch.materialization_complete);
  await actionRequest(`batches/${id}/approve`, {});
  const reached: string[] = [];
  for (let page = 0; ; page += PAGE) {
    const current = await actionRequest<BatchView>(`batches/${id}?offset=${page}&limit=${PAGE}`);
    const targets = current.items
      .filter((item) => ["pending", "running", "retryable_failed"].includes(item.status))
      .map((item) => item.photo_id);
    if (targets.length > 0) {
      await actionRequest(`batches/${id}/apply`, { photo_ids: targets });
      reached.push(...targets);
    }
    if (page + PAGE >= current.total) break;
  }
  return { photoIds: reached, leftOut };
}
