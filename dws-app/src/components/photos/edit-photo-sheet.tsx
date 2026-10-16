"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import PhotoMetaFields, {
  EMPTY_META,
  type PhotoMeta,
} from "@/components/photos/photo-meta-fields";
import { useTagChoices } from "@/components/photos/tag-dropdown";
import { appendResolvedTag } from "@/lib/photos/tags";
import { fetchJson, patchPhotoRows } from "@/lib/photos/api";
import type { PhotoRow } from "@/lib/photos/types";

// "Edit tags": tags save here. Changing the project is its own action in the
// viewer ("Set project"), so it is no longer tucked under this form.

interface EditPhotoSheetProps {
  photo: PhotoRow | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /**
   * Fired after a successful save, before the sheet closes. The sheet has
   * already put the saved row into every cached list, so this need not refresh.
   */
  onSaved?(): void;
}

export default function EditPhotoSheet({
  photo,
  open,
  onOpenChange,
  onSaved,
}: EditPhotoSheetProps) {
  const [meta, setMeta] = useState<PhotoMeta>(EMPTY_META);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const choices = useTagChoices(open, photo?.job_id);

  // Seed from the photo each time the sheet opens on one.
  const photoId = photo?.id;
  useEffect(() => {
    if (open && photo) {
      // Project and albums are not edited here (showDestination={false}).
      setMeta({ ...EMPTY_META, tags: photo.tags });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, photoId]);

  const save = async () => {
    if (!photo) {
      toast.error("This photo is no longer available");
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const answer = await fetchJson<{ photo: PhotoRow }>(`/api/photos/${photo.id}`, "Saving failed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: appendResolvedTag(meta.tags, meta.tagInput, choices.spellings),
        }),
      });
      // PATCH answers the whole saved row: every cached grid and the open photo
      // show the new tags at once, and tag-filtered grids and tag menus refresh
      // (CODE-1), instead of refetching every loaded page of every grid.
      patchPhotoRows(queryClient, [answer.photo]);
      toast.success("Photo updated");
      onSaved?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Saving failed");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return; // don't drop an in-flight save
    onOpenChange(next);
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={handleOpenChange}
      title="Edit tags"
      footer={
        <Button
          onClick={save}
          disabled={busy}
          className="h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {busy ? "Saving..." : "Save"}
        </Button>
      }
    >
      <PhotoMetaFields
        value={meta}
        onChange={setMeta}
        tagChoices={choices}
        enabled={open}
        disabled={busy}
        showDestination={false}
      />
    </SheetShell>
  );
}
