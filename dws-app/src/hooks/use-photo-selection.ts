"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { GridSelection } from "@/components/photos/photo-grid";
import type { PhotoIdsAnswer } from "@/lib/photos/api";
import type { PhotoGroup } from "@/lib/photos/group";
import {
  addToSelection,
  selectionCappedMessage,
  selectionLimitMessage,
  selectionRange,
  toggleGroupSelection,
  toggleSelection,
  type SelectionChange,
} from "@/lib/photos/selection";

/**
 * Select-many state for one photo grid. The rules are the pure functions in
 * lib/photos/selection.ts; this only holds the set, the shift-click anchor, and
 * the message shown when a tick is refused at the limit.
 *
 * Beside the ticks on loaded tiles, two paths take photos that are not loaded
 * yet: `selectAll` adds an answer from GET /api/photos/ids, and a group-header
 * tick, given `groupIds`, ticks the loaded photos at once and then adds (or
 * takes away) the rest of the group when the server's answer arrives.
 */
export function usePhotoSelection(
  groups: PhotoGroup[],
  /** Every id in one group, loaded or not; null when nothing but its loaded photos can be named. */
  groupIds?: (group: PhotoGroup) => Promise<PhotoIdsAnswer> | null
) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  // Refs so the callbacks keep one identity while pages keep arriving. The
  // selection ref is also written on every change, so an answer arriving
  // before the next render builds on the latest set.
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;
  // Bumped by clear(): an answer asked for before it belongs to another selection.
  const generationRef = useRef(0);
  const orderedIds = useMemo(
    () => groups.flatMap((group) => group.photos.map((photo) => photo.id)),
    [groups]
  );
  const orderedRef = useRef(orderedIds);
  orderedRef.current = orderedIds;

  const commit = useCallback((next: Set<string>) => {
    selectedRef.current = next;
    setSelectedIds(next);
  }, []);

  const apply = useCallback(
    (change: SelectionChange) => {
      commit(change.selected);
      setLimitMessage(change.refused > 0 ? selectionLimitMessage() : null);
    },
    [commit]
  );

  /** Every id in `answer`, up to the limit; says so when the server matched more than it sent. */
  const selectAll = useCallback(
    (answer: PhotoIdsAnswer) => {
      const change = addToSelection(selectedRef.current, answer.ids);
      commit(change.selected);
      setLimitMessage(
        change.refused > 0
          ? selectionLimitMessage()
          : answer.truncated
            ? selectionCappedMessage(answer.total)
            : null
      );
    },
    [commit]
  );

  const clear = useCallback(() => {
    generationRef.current += 1;
    anchorRef.current = null;
    commit(new Set());
    setLimitMessage(null);
  }, [commit]);

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
      onToggleGroup: (group) => {
        const loaded = group.photos.map((photo) => photo.id);
        const removing = loaded.length > 0 && loaded.every((id) => selectedRef.current.has(id));
        apply(toggleGroupSelection(selectedRef.current, loaded));
        const pending = groupIdsRef.current?.(group);
        if (!pending) return;
        const generation = generationRef.current;
        pending.then(
          (answer) => {
            if (generation !== generationRef.current) return;
            if (!removing) {
              selectAll(answer);
              return;
            }
            const next = new Set(selectedRef.current);
            for (const id of answer.ids) next.delete(id);
            commit(next);
            setLimitMessage(null);
          },
          () => {
            if (generation !== generationRef.current) return;
            toast.error(
              removing
                ? "Could not unselect the rest of that group. Try again."
                : "Could not select the rest of that group: only the photos on screen are selected."
            );
          }
        );
      },
    }),
    [selectedIds, apply, commit, selectAll]
  );

  return { selection, selectedIds, count: selectedIds.size, clear, limitMessage, selectAll };
}
