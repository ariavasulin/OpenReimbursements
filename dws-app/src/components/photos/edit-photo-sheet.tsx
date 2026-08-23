"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import JobCombobox from "@/components/photos/job-combobox";
import TagInput, { appendTag, withPendingTag } from "@/components/photos/tag-input";
import { fetchJobs, fetchTags } from "@/lib/photos/api";
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
  const isMobile = useMobile();
  const [jobId, setJobId] = useState("");
  const [sheetNumber, setSheetNumber] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: jobs } = useQuery({
    queryKey: ["photo-jobs", ""],
    queryFn: () => fetchJobs(),
    enabled: open,
  });
  const { data: knownTags } = useQuery({
    queryKey: ["photo-tags"],
    queryFn: () => fetchTags(),
    enabled: open,
  });

  // Seed from the photo each time the sheet opens.
  useEffect(() => {
    if (open && photo) {
      setJobId(photo.job_id);
      setSheetNumber(photo.sheet_number ?? "");
      setTags(photo.tags);
      setTagInput("");
    }
  }, [open, photo]);

  const tagSuggestions = useMemo(() => {
    const query = tagInput.trim().toLowerCase();
    if (!query) return [];
    return (knownTags ?? [])
      .filter(
        (tag) => tag.toLowerCase().includes(query) && !tags.includes(tag)
      )
      .slice(0, 6);
  }, [tagInput, knownTags, tags]);

  const addTag = (tag: string) => {
    setTags((previous) => appendTag(previous, tag));
    setTagInput("");
  };

  const save = async () => {
    if (!photo) return;
    if (!jobId) {
      toast.error("Pick a job first");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/photos/${photo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          sheet_number: sheetNumber.trim() || null,
          tags: withPendingTag(tags, tagInput),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Saving failed (${response.status})`);
      }
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
      heightClass="h-[70dvh] max-h-[70dvh]"
      desktopClass="h-[min(85dvh,520px)] max-h-[85dvh]"
      header={
        <div className="mb-3 text-[15px] font-semibold text-white">
          Edit photo
        </div>
      }
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
      <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
      <JobCombobox
        jobs={jobs ?? []}
        value={jobId}
        onChange={setJobId}
        disabled={busy}
        mode={isMobile ? "picker" : "inline"}
      />

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">
        Sheet # (optional)
      </label>
      <input
        type="text"
        inputMode="numeric"
        value={sheetNumber}
        onChange={(event) => setSheetNumber(event.target.value)}
        placeholder="e.g. 12"
        disabled={busy}
        className="mb-3.5 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none md:text-sm"
      />

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">
        Tags (optional)
      </label>
      <TagInput
        className="mb-1"
        tags={tags}
        input={tagInput}
        onInputChange={setTagInput}
        onAdd={addTag}
        onRemove={(tag) =>
          setTags((previous) => previous.filter((t) => t !== tag))
        }
        disabled={busy}
      />
      {tagSuggestions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tagSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => addTag(tag)}
              className="rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-2.5 py-1 text-xs text-[#d0d0d0] hover:border-[#2680FC]"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </SheetShell>
  );
}
