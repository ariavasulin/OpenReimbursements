"use client";

import { memo, useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import AlbumField from "@/components/photos/album-field";
import SheetShell from "@/components/photos/sheet-shell";
import { addPhotosToAlbum, invalidateAlbum, invalidatePhotoCaches, removePhotosFromAlbum } from "@/lib/photos/api";
import { inChunks, PartialBulkError, sumCounts } from "@/lib/photos/chunks";
import { formatCount, plural } from "@/lib/photos/format";
import type { PhotoAlbumRef } from "@/lib/photos/types";
import { errorText, primaryButton, sendInSlices, sliceError, type BulkSheetProps } from "./bulk-feedback";

// The selection bar's "Add to album": pick one or more albums, and the
// selected photos go into each at once (500 a request, under one toast).

function AddToAlbumSheet({ open, onOpenChange, photoIds, onDone }: BulkSheetProps) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [albums, setAlbums] = useState<PhotoAlbumRef[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setAlbums([]);
  }, [open]);

  const save = async () => {
    if (albums.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const album of albums) {
        const { results, toastId } = await sendInSlices(
          photoIds,
          (chunk) => addPhotosToAlbum(album.id, chunk),
          (sent, total) => `Adding ${plural(total, "photo")} to “${album.name}”… ${formatCount(sent)} done`
        );
        const result = sumCounts(results, ["added", "already", "missing"]);
        // Only this album's grid, header, and card changed. A photo that went
        // missing (trashed meanwhile) means other lists are stale too.
        if (result.missing > 0) invalidatePhotoCaches(queryClient);
        else invalidateAlbum(queryClient, album.id, photoIds);
        const detail = [
          result.already > 0 && `${plural(result.already, "photo")} already there`,
          result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
        ].filter(Boolean).join(" · ");
        toast.success(`Added ${plural(result.added, "photo")} to “${album.name}”`, {
          id: toastId,
          description: detail || undefined,
          // Undo takes the photos out again, so it is only offered when that
          // cannot remove one that was in the album before.
          action:
            result.already === 0
              ? {
                  label: "Undo",
                  onClick: () =>
                    void inChunks(photoIds, (chunk) => removePhotosFromAlbum(album.id, chunk))
                      .then(() => invalidatePhotoCaches(queryClient))
                      .catch((reason) => toast.error(errorText(reason, "Could not undo that."))),
                }
              : undefined,
        });
      }
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(sliceError(reason, "Failed to add to the album", (n) => `Added ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={`Add ${plural(photoIds.length, "photo")} to an album`}
      footer={
        <Button onClick={() => void save()} disabled={busy || albums.length === 0} className={primaryButton} size="lg">
          {busy ? "Adding..." : "Add to album"}
        </Button>
      }
    >
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[#d0d0d0]">
        Album
      </label>
      <AlbumField inputId={inputId} value={albums} onChange={setAlbums} enabled={open} disabled={busy} />
      <p className="mt-2 text-sm text-[#b4b4b4]">
        An album is like a folder. A photo can be in more than one, and it stays in its project.
      </p>
    </SheetShell>
  );
}

export default memo(AddToAlbumSheet);
