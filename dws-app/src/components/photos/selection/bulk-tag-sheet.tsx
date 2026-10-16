"use client";

import { memo, useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import TagDropdown, { useTagChoices } from "@/components/photos/tag-dropdown";
import { bulkTagPhotos, invalidatePhotoCaches, patchPhotoTags } from "@/lib/photos/api";
import { PartialBulkError, sumCounts } from "@/lib/photos/chunks";
import { formatCount, plural } from "@/lib/photos/format";
import { appendResolvedTag } from "@/lib/photos/tags";
import { primaryButton, sendInSlices, sliceError, type BulkSheetProps } from "./bulk-feedback";

// The selection bar's "Tag": add tags to every selected photo, or take them
// off (500 a request, under one toast).

function BulkTagSheet({
  open,
  onOpenChange,
  photoIds,
  jobId,
  onDone,
}: BulkSheetProps & { jobId: string | null }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const choices = useTagChoices(open, jobId);
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Add is the usual job; Remove is how a tag given to the wrong photos comes
  // off them all at once (group by Tag, tick the group, Tag, Remove).
  const [mode, setMode] = useState<"add" | "remove">("add");

  useEffect(() => {
    if (open) {
      setTags([]);
      setInput("");
      setMode("add");
    }
  }, [open]);

  const pending = appendResolvedTag(tags, input, choices.spellings);
  const removing = mode === "remove";

  const save = async () => {
    if (pending.length === 0 || busy) return;
    setBusy(true);
    try {
      const { results, toastId } = await sendInSlices(
        photoIds,
        (chunk) => bulkTagPhotos(chunk, removing ? { remove: pending } : { add: pending }),
        (sent, total) => `${removing ? "Untagging" : "Tagging"} ${plural(total, "photo")}… ${formatCount(sent)} done`
      );
      const result = sumCounts(results, ["updated", "skipped", "missing"]);
      // The answer is counts only. When every photo took the change, apply it
      // to the cached rows ourselves; when some were skipped or gone, which
      // ones is unknown, so everything refreshes.
      if (result.skipped + result.missing > 0) invalidatePhotoCaches(queryClient);
      else patchPhotoTags(queryClient, photoIds, removing ? { remove: pending } : { add: pending });
      const detail = [
        result.skipped > 0 && `${plural(result.skipped, "photo")} skipped: a photo can hold 20 tags`,
        result.missing > 0 && `${plural(result.missing, "photo")} no longer available`,
      ].filter(Boolean).join(" · ");
      toast.success(
        removing
          ? `Removed ${pending.join(", ")} from ${plural(result.updated, "photo")}`
          : `Tagged ${plural(result.updated, "photo")} ${pending.join(", ")}`,
        { id: toastId, description: detail || undefined }
      );
      onOpenChange(false);
      onDone();
    } catch (reason) {
      toast.error(sliceError(reason, removing ? "Failed to remove the tags" : "Failed to tag the photos", (n) => `${removing ? "Untagged" : "Tagged"} ${n}`));
      if (reason instanceof PartialBulkError) invalidatePhotoCaches(queryClient);
    } finally {
      setBusy(false);
    }
  };
  const modeButton = (value: "add" | "remove", label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      disabled={busy}
      onClick={() => setMode(value)}
      className={`min-h-11 flex-1 rounded-lg px-3 text-base font-medium ${
        mode === value ? "bg-[#2680FC] text-white" : "bg-[#3a3a3a] text-[#d0d0d0] hover:bg-[#454545]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={`Tag ${plural(photoIds.length, "photo")}`}
      footer={
        <Button onClick={() => void save()} disabled={busy || pending.length === 0} className={primaryButton} size="lg">
          {busy ? "Saving..." : `${removing ? "Remove" : "Add"} ${pending.length > 1 ? "tags" : "tag"}`}
        </Button>
      }
    >
      <div role="radiogroup" aria-label="Add or remove" className="mb-3 flex gap-2">
        {modeButton("add", "Add tags")}
        {modeButton("remove", "Remove tags")}
      </div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-[#d0d0d0]">
        {removing ? "Tags to remove" : "Tags to add"}
      </label>
      <TagDropdown
        inputId={inputId}
        tags={tags}
        onChange={setTags}
        input={input}
        onInputChange={setInput}
        choices={choices}
        disabled={busy}
      />
    </SheetShell>
  );
}

export default memo(BulkTagSheet);
