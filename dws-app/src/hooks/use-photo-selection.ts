"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { GridSelection } from "@/components/photos/photo-grid";
import type { PhotoGroup } from "@/lib/photos/group";
import {
  addToSelection,
  selectionLimitMessage,
  selectionRange,
  toggleGroupSelection,
  toggleSelection,
  type SelectionChange,
} from "@/lib/photos/selection";

/**
 * Select-many state for one photo grid. The rules are the pure functions in
 * lib/photos/selection.ts; this only holds the set, the shift-click anchor, and
 * the message shown when a tick is refused at the 500 limit.
 */
export function usePhotoSelection(groups: PhotoGroup[]) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  // Refs so the callbacks keep one identity while pages keep arriving.
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const orderedIds = useMemo(
    () => groups.flatMap((group) => group.photos.map((photo) => photo.id)),
    [groups]
  );
  const orderedRef = useRef(orderedIds);
  orderedRef.current = orderedIds;

  const apply = useCallback((change: SelectionChange) => {
    setSelectedIds(change.selected);
    setLimitMessage(change.refused > 0 ? selectionLimitMessage() : null);
  }, []);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelectedIds(new Set());
    setLimitMessage(null);
  }, []);

  const selection = useMemo<GridSelection>(
    () => ({
      selectedIds,
      onToggle: (photo, { range }) => {
        if (range && anchorRef.current !== null) {
          apply(
            addToSelection(
              selectedRef.current,
              selectionRange(orderedRef.current, anchorRef.current, photo.id)
            )
          );
        } else {
          apply(toggleSelection(selectedRef.current, photo.id));
        }
        anchorRef.current = photo.id;
      },
      onToggleGroup: (group) =>
        apply(
          toggleGroupSelection(
            selectedRef.current,
            group.photos.map((photo) => photo.id)
          )
        ),
    }),
    [selectedIds, apply]
  );

  return { selection, selectedIds, count: selectedIds.size, clear, limitMessage };
}
