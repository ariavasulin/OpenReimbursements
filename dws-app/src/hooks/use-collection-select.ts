import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invalidatePhotoCaches } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { toggleSelection } from "@/lib/photos/selection";

/**
 * Select mode on the Albums and Projects lists: which cards are ticked, the
 * Rename and Delete dialogs, and deleting the chosen ones. Leaving select mode
 * hands focus back to the Select button (`selectButton`).
 */
export function useCollectionSelect<T extends { id: string }>(
  items: T[] | undefined,
  { noun, deleteOne, deletedDescription }: {
    /** "album" / "project", for the toasts. */
    noun: string;
    deleteOne(id: string): Promise<unknown>;
    deletedDescription: string;
  }
) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectButton = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  useEffect(() => {
    if (wasSelecting.current && selected === null) selectButton.current?.focus();
    wasSelecting.current = selected !== null;
  }, [selected]);

  const chosen = (items ?? []).filter((item) => selected?.has(item.id));
  const toggle = (id: string) =>
    setSelected((current) => toggleSelection(current ?? new Set(), id).selected);

  /** Deletes every chosen item; a failure keeps select mode on the ones left. */
  const remove = async () => {
    setBusy(true);
    const results = await Promise.allSettled(chosen.map((item) => deleteOne(item.id)));
    const deleted = results.filter((result) => result.status === "fulfilled").length;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      toast.error(failure.reason instanceof Error ? failure.reason.message : `Failed to delete the ${noun}`, {
        description: deleted > 0 ? `${plural(deleted, noun)} deleted.` : undefined,
      });
    } else {
      toast.success(`${plural(deleted, noun)} deleted`, { description: deletedDescription });
      setSelected(null);
    }
    invalidatePhotoCaches(queryClient);
    setBusy(false);
    setConfirming(false);
  };

  return {
    selected,
    start: () => setSelected(new Set()),
    stop: () => setSelected(null),
    chosen,
    toggle,
    busy,
    renaming,
    setRenaming,
    confirming,
    setConfirming,
    remove,
    selectButton,
  };
}
