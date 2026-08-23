"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import PhotoMetaFields, {
  EMPTY_META,
  type PhotoMeta,
} from "@/components/photos/photo-meta-fields";
import { appendTag } from "@/lib/photos/tags";
import { fetchJson } from "@/lib/photos/api";
import type { PhotoRow } from "@/lib/photos/types";

// Edit one photo's job / sheet / tags. Opened from the lightbox; lives in its
// own SheetShell (above the lightbox) so the keyboard and job picker get the
// same fixed-frame treatment as the upload sheet.

interface EditPhotoSheetProps {
  photo: PhotoRow | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Fired after a successful save, before the sheet closes. */
  onSaved(): void;
}

export default function EditPhotoSheet({
  photo,
  open,
  onOpenChange,
  onSaved,
}: EditPhotoSheetProps) {
  const [meta, setMeta] = useState<PhotoMeta>(EMPTY_META);
  const [busy, setBusy] = useState(false);

  // Seed from the photo each time the sheet opens on one.
  const photoId = photo?.id;
  useEffect(() => {
    if (open && photo) {
      setMeta({
        jobId: photo.job_id,
        sheetNumber: photo.sheet_number ?? "",
        tags: photo.tags,
        tagInput: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, photoId]);

  const save = async () => {
    if (!photo) {
      toast.error("This photo is no longer available");
      onOpenChange(false);
      return;
    }
    if (!meta.jobId) {
      toast.error("Pick a job first");
      return;
    }
    setBusy(true);
    try {
      await fetchJson(`/api/photos/${photo.id}`, "Saving failed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: meta.jobId,
          sheet_number: meta.sheetNumber.trim() || null,
          tags: appendTag(meta.tags, meta.tagInput),
        }),
      });
      toast.success("Photo updated");
      onSaved();
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
      title="Edit photo"
      size="compact"
      footer={
        <Button
          onClick={save}
          disabled={busy}
          className="w-full bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {busy ? "Saving..." : "Save"}
        </Button>
      }
    >
      <PhotoMetaFields
        value={meta}
        onChange={setMeta}
        enabled={open}
        disabled={busy}
        jobFallback={photo?.job}
      />
    </SheetShell>
  );
}
