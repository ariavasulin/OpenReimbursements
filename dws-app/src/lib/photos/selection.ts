// Pure select-many rules for the photo grid. Ids, never positions: grouped by
// tag the same photo sits in several groups, and pages keep arriving.

import { MAX_BULK_PHOTOS } from "./apiShared";

/** Most photos one selection may hold — the bulk routes' own limit. */
export const MAX_SELECTION = MAX_BULK_PHOTOS;

/**
 * Shift-click: every photo from the anchor to the target in display order,
 * both ends included, each id once. `orderedIds` may repeat an id (tag groups);
 * the first place counts. No usable anchor means just the target.
 */
export function selectionRange(
  orderedIds: string[],
  anchorId: string | null,
  targetId: string
): string[] {
  const to = orderedIds.indexOf(targetId);
  const from = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
  if (to === -1) return [];
  if (from === -1) return [targetId];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return [...new Set(orderedIds.slice(start, end + 1))];
}

export interface SelectionChange {
  selected: Set<string>;
  /** Ids left out because the selection was already at its limit. */
  refused: number;
}

/** Add ids up to the limit; what does not fit is counted, never dropped silently. */
export function addToSelection(
  selected: ReadonlySet<string>,
  ids: string[],
  limit = MAX_SELECTION
): SelectionChange {
  const next = new Set(selected);
  let refused = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    if (next.size >= limit) refused += 1;
    else next.add(id);
  }
  return { selected: next, refused };
}

/** One tick: off if it was on, on if there is room. */
export function toggleSelection(
  selected: ReadonlySet<string>,
  id: string,
  limit = MAX_SELECTION
): SelectionChange {
  if (!selected.has(id)) return addToSelection(selected, [id], limit);
  const next = new Set(selected);
  next.delete(id);
  return { selected: next, refused: 0 };
}

/**
 * A group's header tick: selects the whole group, or clears it when every photo
 * in it is already selected.
 */
export function toggleGroupSelection(
  selected: ReadonlySet<string>,
  groupIds: string[],
  limit = MAX_SELECTION
): SelectionChange {
  if (groupIds.length > 0 && groupIds.every((id) => selected.has(id))) {
    const next = new Set(selected);
    for (const id of groupIds) next.delete(id);
    return { selected: next, refused: 0 };
  }
  return addToSelection(selected, groupIds, limit);
}

/** The plain sentence the bar shows when a tick was refused. */
export function selectionLimitMessage(limit = MAX_SELECTION): string {
  return `You can select up to ${limit} photos at a time. Finish with these first, then select more.`;
}
