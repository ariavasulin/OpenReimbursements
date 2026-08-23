// Pure helpers for the pending batch in the upload sheet. `files`, `items`,
// and `previews` are three arrays indexed by the same file position, so any
// removal has to shift all three together.

export interface BatchState<TFile, TItem, TPreview> {
  files: TFile[];
  items: TItem[];
  previews: TPreview[];
}

export function removeAt<TFile, TItem, TPreview>(
  state: BatchState<TFile, TItem, TPreview>,
  index: number
): BatchState<TFile, TItem, TPreview> {
  const drop = <T>(list: T[]) => list.filter((_, i) => i !== index);
  return {
    files: drop(state.files),
    items: drop(state.items),
    previews: drop(state.previews),
  };
}

/** Only pending and failed files may leave the batch; in-flight and landed stay. */
export function canRemove(
  status:
    | "pending"
    | "uploading"
    | "done"
    | "failed"
    | "duplicate"
    | "interrupted"
): boolean {
  return status === "pending" || status === "failed";
}

/** null when nothing is left. */
export function nextPreviewIndex(
  current: number,
  removed: number,
  remaining: number
): number | null {
  if (remaining <= 0) return null;
  const shifted = removed < current ? current - 1 : current;
  return Math.min(shifted, remaining - 1);
}
