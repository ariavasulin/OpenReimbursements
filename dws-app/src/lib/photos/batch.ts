// Pure helpers for the pending batch in the upload sheet. `files` and
// `previews` are two arrays indexed by the same file position, so any
// removal has to shift both together.

export interface BatchState<TFile, TPreview> {
  files: TFile[];
  previews: TPreview[];
}

export function removeAt<TFile, TPreview>(
  state: BatchState<TFile, TPreview>,
  index: number
): BatchState<TFile, TPreview> {
  const drop = <T,>(list: T[]) => list.filter((_, i) => i !== index);
  return {
    files: drop(state.files),
    previews: drop(state.previews),
  };
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
