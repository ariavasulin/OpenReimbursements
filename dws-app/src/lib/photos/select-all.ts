// The selection bar's "Select all M" link, worked out from a count of the
// grid's matches (GET /api/photos/ids?count=1) instead of every matching id:
// the ids, up to 5,000 of them, are fetched when the link is clicked, or when
// the count alone cannot say whether the link is needed (selectAllNeedsIds).

import { formatCount } from "./format";
import { MAX_SELECTION } from "./selection";

/**
 * What the count says about the selection. The loaded photos all match, so the
 * selected ones among them certainly match; the rest of the selection may or
 * may not. "some-unselected" when even if every one of the rest matched, some
 * matches would be left; "all-selected" when the loaded, selected photos alone
 * are every match; otherwise "unsure": a selection made under one filter and
 * carried to another (tick project A, filter to project B) can look complete
 * by count while matches of B are still unticked.
 */
function countVerdict(
  selectedIds: ReadonlySet<string>,
  matchCount: number | undefined,
  loaded: ReadonlyMap<string, unknown>
): "some-unselected" | "all-selected" | "unsure" | null {
  const count = selectedIds.size;
  // No count yet, or no room left: no link either way.
  if (matchCount === undefined || count >= MAX_SELECTION) return null;
  let selectedLoaded = 0;
  for (const id of selectedIds) if (loaded.has(id)) selectedLoaded += 1;
  const notLoaded = Math.max(0, matchCount - loaded.size);
  if (selectedLoaded + Math.min(notLoaded, count - selectedLoaded) < matchCount) return "some-unselected";
  return selectedLoaded >= matchCount ? "all-selected" : "unsure";
}

/** True when only the matching ids can say whether the link should show. */
export function selectAllNeedsIds(
  selectedIds: ReadonlySet<string>,
  matchCount: number | undefined,
  loaded: ReadonlyMap<string, unknown>
): boolean {
  return countVerdict(selectedIds, matchCount, loaded) === "unsure";
}

/**
 * The link's words, or null when it should not show: no count yet, the
 * selection is full, or every match is selected already. When the count alone
 * cannot tell, `matchIds` (the grid's matching ids, once fetched) decides; until
 * they arrive the link stays hidden.
 */
export function selectAllLabel(
  selectedIds: ReadonlySet<string>,
  matchCount: number | undefined,
  /** The grid's loaded photos by id, every one a match for its filters. */
  loaded: ReadonlyMap<string, unknown>,
  matchIds?: readonly string[]
): string | null {
  const verdict = countVerdict(selectedIds, matchCount, loaded);
  if (verdict === null || verdict === "all-selected" || matchCount === undefined) return null;
  if (verdict === "unsure" && (!matchIds || matchIds.every((id) => selectedIds.has(id)))) return null;
  return matchCount > MAX_SELECTION
    ? `Select all ${formatCount(MAX_SELECTION)} (of ${formatCount(matchCount)})`
    : `Select all ${formatCount(matchCount)}`;
}
