// Which selection-bar actions apply, and which fit in the bar versus behind
// "More" — the pure part of components/photos/selection-bar.tsx, for tests.
// Desktop fits by measured width; a phone by a fixed number of bottom slots.

/** What the bar can do with a selection, besides Trash. */
export type SelectionActionKey = "download" | "album" | "remove" | "tag" | "project" | "rename";

/** The order actions appear in, on every screen and in every More list. */
export const ACTION_ORDER: readonly SelectionActionKey[] = ["download", "album", "remove", "tag", "project", "rename"];

/** Which go into More first when they do not all fit: the least used first. */
export const FOLD_ORDER: readonly SelectionActionKey[] = ["rename", "project", "tag", "remove", "album", "download"];

/** Buttons in the phone's bottom row, More and Trash included: five fit 390 px at ≥44 px each. */
export const PHONE_SLOTS = 5;

/** The actions a selection offers: Remove from album only in an album, Rename only for one photo. */
export function selectionActions(options: { inAlbum: boolean; count: number }): SelectionActionKey[] {
  return ACTION_ORDER.filter(
    (key) => (key !== "remove" || options.inAlbum) && (key !== "rename" || options.count === 1)
  );
}

/**
 * Split actions into the ones shown in the bar and the ones behind More,
 * folding the least used first (`foldOrder`) until `fits` says the rest, plus
 * More, fit. Both lists keep the actions' own order. Pure, for tests.
 */
export function fitActions<K extends string>(
  keys: readonly K[],
  foldOrder: readonly K[],
  fits: (shown: readonly K[], withMore: boolean) => boolean
): { shown: K[]; more: K[] } {
  if (fits(keys, false)) return { shown: [...keys], more: [] };
  const folded = new Set<K>();
  for (const key of foldOrder) {
    if (!keys.includes(key)) continue;
    folded.add(key);
    const shown = keys.filter((k) => !folded.has(k));
    if (fits(shown, true)) return { shown, more: keys.filter((k) => folded.has(k)) };
  }
  return { shown: [], more: [...keys] };
}

/** The phone's bottom row: everything if it fits PHONE_SLOTS, else fold into More. */
export function phoneActions(keys: readonly SelectionActionKey[], withTrash: boolean) {
  return fitActions(
    keys,
    FOLD_ORDER,
    (shown, withMore) => shown.length + (withMore ? 1 : 0) + (withTrash ? 1 : 0) <= PHONE_SLOTS
  );
}

/** The gap between desktop action buttons (`gap-1`), in px. */
export const DESKTOP_GAP = 4;

/** The desktop row: as many as fit `available` px, given each button's measured width. */
export function desktopActions(
  keys: readonly SelectionActionKey[],
  widths: Readonly<Partial<Record<SelectionActionKey | "more", number>>>,
  available: number
) {
  return fitActions(keys, FOLD_ORDER, (shown, withMore) => {
    const items = [...shown.map((key) => widths[key] ?? 0), ...(withMore ? [widths.more ?? 0] : [])];
    const total = items.reduce((sum, width) => sum + width, 0) + DESKTOP_GAP * Math.max(0, items.length - 1);
    return total <= available + 0.5;
  });
}
