// Pure helpers for the pending batch in the upload sheet. `files` and
// `previews` are two arrays indexed by the same file position, so any
// removal has to shift both together.

export function removeAt(
  files: File[],
  previews: (string | null)[],
  index: number
) {
  const drop = <T>(list: T[]) => list.filter((_, i) => i !== index);
  return { files: drop(files), previews: drop(previews) };
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
