// Pure helpers for the pending batch in the upload sheet.

/** Where the full-screen preview lands after a removal; null when nothing is
 * left. */
export function nextPreviewIndex(
  current: number,
  removed: number,
  remaining: number
): number | null {
  if (remaining <= 0) return null;
  const shifted = removed < current ? current - 1 : current;
  return Math.min(shifted, remaining - 1);
}
