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

/**
 * The files a file input holds, clearing the input on the way out — without
 * the reset, re-picking the same file fires no `change` event.
 */
export function readInputFiles(input: HTMLInputElement): File[] {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}

/**
 * File-picker accept attribute: generic `image/*,video/*` on iOS ONLY —
 * explicitly listing image/heic defeats Safari's automatic HEIC→JPEG
 * conversion. Everywhere else the picker stays unrestricted so companion
 * files (XMP sidecars, RAW) remain pickable.
 */
export function pickerAccept(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    ? "image/*,video/*"
    : undefined;
}
