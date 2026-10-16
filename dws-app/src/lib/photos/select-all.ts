// The selection bar's "Select all M" link, worked out from a count of the
// grid's matches (GET /api/photos/ids?count=1) instead of every matching id:
// the ids, up to 5,000 of them, are fetched only when the link is clicked.

import { formatCount } from "./format";
import { MAX_SELECTION } from "./selection";

/**
 * The link's words, or null when it should not show: no count yet, the
 * selection is full, or every match is certainly selected already.
 *
 * A count cannot say which matches are selected, so this works out the most
 * that could be: the selected photos among the loaded ones (all of which
 * match), plus the rest of the selection, capped at the matches not loaded.
 * A selection made under one filter and carried to another (tick project A,
 * filter to project B) mostly falls outside B, so the link still offers B.
 * The link may show when everything is in fact selected; a click then adds
 * nothing.
 */
export function selectAllLabel(
  selectedIds: ReadonlySet<string>,
  matchCount: number | undefined,
  /** The grid's loaded photos by id, every one a match for its filters. */
  loaded: ReadonlyMap<string, unknown>
): string | null {
  const count = selectedIds.size;
  if (matchCount === undefined || count >= MAX_SELECTION) return null;
  let selectedLoaded = 0;
  for (const id of selectedIds) if (loaded.has(id)) selectedLoaded += 1;
  const notLoaded = Math.max(0, matchCount - loaded.size);
  const mostSelected = selectedLoaded + Math.min(notLoaded, count - selectedLoaded);
  if (mostSelected >= matchCount) return null;
  return matchCount > MAX_SELECTION
    ? `Select all ${formatCount(MAX_SELECTION)} (of ${formatCount(matchCount)})`
    : `Select all ${formatCount(matchCount)}`;
}
