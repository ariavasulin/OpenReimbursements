// Pure helpers for the pending batch in the upload sheet. `files`, `items`,
// and `previews` are three arrays indexed by the same file position, so any
// removal has to shift all three together — that's the only reason this
// exists as a separate, testable module.

export interface BatchState<TFile, TItem, TPreview> {
  files: TFile[];
  items: TItem[];
  previews: TPreview[];
}

/** Drop position `index` from every array; out-of-range is a no-op. */
export function removeAt<TFile, TItem, TPreview>(
  state: BatchState<TFile, TItem, TPreview>,
  index: number
): BatchState<TFile, TItem, TPreview> {
  if (index < 0 || index >= state.files.length) return state;
  const drop = <T>(list: T[]) => list.filter((_, i) => i !== index);
  return {
    files: drop(state.files),
    items: drop(state.items),
    previews: drop(state.previews),
  };
}

/** A file can leave the batch only before it goes over the wire or after it
 *  failed — in-flight and landed files stay. */
export function canRemove(status: string): boolean {
  return status === "pending" || status === "failed";
}

/** Where the full-screen preview should sit after removing `removed` while
 *  viewing `current`, given `remaining` files; null when nothing is left. */
export function nextPreviewIndex(
  current: number,
  removed: number,
  remaining: number
): number | null {
  if (remaining <= 0) return null;
  const shifted = removed < current ? current - 1 : current;
  return Math.min(shifted, remaining - 1);
}
