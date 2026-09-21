"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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

// Tags save here; changing ownership opens exact-target review.

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
        // The project field is hidden here (showJob={false}); a photo may have none.
        jobId: photo.job_id ?? "",
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
    setBusy(true);
    try {
      await fetchJson(`/api/photos/${photo.id}`, "Saving failed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        showJob={false}
      />
      {photo && <div className="mt-4 border-t border-[#4e4e4e] pt-4 text-sm text-[#bbb]">
        <p>Save any tag changes before moving this photo.</p>
        <Link href={`/photos/actions?action=move&photo=${encodeURIComponent(photo.id)}`}
          onClick={(event) => { if (busy) event.preventDefault(); else onOpenChange(false); }}
          aria-disabled={busy} className="mt-2 inline-block text-[#8bbaff] underline">
          Review move to another job
        </Link>
      </div>}
    </SheetShell>
  );
}
