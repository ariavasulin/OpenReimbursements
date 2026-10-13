import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CardSelection } from "@/components/photos/collection-card";
import { invalidatePhotoCaches } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { addToSelection, selectionRange, toggleSelection } from "@/lib/photos/selection";

/**
 * Selecting on the Albums and Projects lists, the way photos are selected:
 * ticking one card (or holding it on a phone) starts selecting, and clearing
 * the last one stops. Also holds the Rename and Delete dialogs and deleting
 * the chosen ones.
 */
export function useCollectionSelect<T extends { id: string }>(
  items: T[] | undefined,
  { noun, deleteOne, deletedDescription, canDelete = () => true }: {
    /** "album" / "project", for the toasts. */
    noun: string;
    deleteOne(id: string): Promise<unknown>;
    deletedDescription: string;
    /** Whether this person may delete the item (permissions.ts); Delete acts on these only. */
    canDelete?(item: T): boolean;
  }
) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The last card ticked: the start of a shift-click range (until cleared),
  // and where focus goes back to when the bar closes under it.
  const anchor = useRef<string | null>(null);
  const lastTicked = useRef<string | null>(null);

  // Only ids still in the list count, so a deleted card never keeps the bar up.
  const chosen = (items ?? []).filter((item) => selected.has(item.id));
  const deletable = chosen.filter(canDelete);
  const selecting = chosen.length > 0;

  const wasSelecting = useRef(false);
  useEffect(() => {
    // Closing the bar removes the focused button: put focus back on the card.
    if (wasSelecting.current && !selecting && lastTicked.current && document.activeElement === document.body) {
      document.querySelector<HTMLElement>(`[data-select-id="${CSS.escape(lastTicked.current)}"]`)?.focus();
    }
    wasSelecting.current = selecting;
  }, [selecting]);

  const toggle = (id: string, { range }: { range: boolean }) => {
    const from = range ? anchor.current : null;
    const order = (items ?? []).map((item) => item.id);
    setSelected((current) =>
      from !== null
        ? addToSelection(current, selectionRange(order, from, id)).selected
        : toggleSelection(current, id).selected
    );
    anchor.current = id;
    lastTicked.current = id;
  };

  /** Deletes every chosen item this person may delete; a failure keeps the ones left selected. */
  const remove = async () => {
    setBusy(true);
    const results = await Promise.allSettled(deletable.map((item) => deleteOne(item.id)));
    const deleted = results.filter((result) => result.status === "fulfilled").length;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      toast.error(failure.reason instanceof Error ? failure.reason.message : `Failed to delete the ${noun}`, {
        description: deleted > 0 ? `${plural(deleted, noun)} deleted.` : undefined,
      });
    } else {
      toast.success(`${plural(deleted, noun)} deleted`, { description: deletedDescription });
      setSelected(new Set());
    }
    invalidatePhotoCaches(queryClient);
    setBusy(false);
    setConfirming(false);
  };

  return {
    selecting,
    /** What one card needs to draw its tick and toggle. */
    card: (id: string): CardSelection => ({
      id,
      selected: selected.has(id),
      selecting,
      onToggle: (options) => toggle(id, options),
    }),
    stop: () => {
      anchor.current = null;
      setSelected(new Set());
    },
    chosen,
    deletable,
    busy,
    renaming,
    setRenaming,
    confirming,
    setConfirming,
    remove,
  };
}
