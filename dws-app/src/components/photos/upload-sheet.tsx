"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMobile } from "@/hooks/use-mobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import JobCombobox from "@/components/photos/job-combobox";
import BatchPreview from "@/components/photos/batch-preview";
import { useUploadManager } from "@/lib/photos/upload-manager";
import TagInput, { appendTag, withPendingTag } from "@/components/photos/tag-input";
import { fetchJobs, fetchTags } from "@/lib/photos/api";
import { readSidecarMeta } from "@/lib/photos/sidecar";
import { plural } from "@/lib/photos/format";
import { nextPreviewIndex, removeAt } from "@/lib/photos/batch";

// One job, sheet, and tag set per batch. Drawer on mobile, Dialog on desktop.
// The batch is copied into local state so files can be removed before upload.
// The sheet is compose-only: Upload hands the batch to the app-level upload
// manager and closes; the tray (upload-tray.tsx) shows progress from there.

function makePreviews(files: File[]): (string | null)[] {
  return files.map((file) =>
    file.type.startsWith("image/") ? URL.createObjectURL(file) : null
  );
}

function revokePreviews(previews: (string | null)[]) {
  for (const url of previews) if (url) URL.revokeObjectURL(url);
}

interface UploadSheetProps {
  /** The picked/shot batch; the sheet keeps its own editable copy. */
  files: File[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Pre-selects the job when uploading from inside a job. */
  defaultJobId?: string;
  /** Shutter times for in-app camera shots (see CameraShot). */
  capturedAtOverrides?: Map<File, Date>;
  /** Paired .xmp per primary image (pairByBasename ran at pick time). */
  sidecars?: Map<File, File>;
}

export default function UploadSheet({
  files: initialFiles,
  open,
  onOpenChange,
  defaultJobId,
  capturedAtOverrides,
  sidecars,
}: UploadSheetProps) {
  const isMobile = useMobile();
  const manager = useUploadManager();
  const [jobId, setJobId] = useState(defaultJobId ?? "");
  const [sheetNumber, setSheetNumber] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const previewsRef = useRef<(string | null)[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

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

  // Reset per new batch.
  useEffect(() => {
    if (open) {
      setJobId(defaultJobId ?? "");
      setSheetNumber("");
      setTags([]);
      setTagInput("");
      setPreviewIndex(null);
      setFiles(initialFiles);
      revokePreviews(previewsRef.current);
      const next = makePreviews(initialFiles);
      previewsRef.current = next;
      setPreviews(next);
    }
  }, [open, initialFiles, defaultJobId]);
  // Object URLs outlive React state, so release whatever is current on unmount.
  useEffect(() => {
    return () => revokePreviews(previewsRef.current);
  }, []);

  const removeFile = (index: number) => {
    const url = previews[index];
    if (url) URL.revokeObjectURL(url);
    const next = removeAt({ files, previews }, index);
    setFiles(next.files);
    previewsRef.current = next.previews;
    setPreviews(next.previews);
    setPreviewIndex((current) =>
      current === null
        ? null
        : nextPreviewIndex(current, index, next.files.length)
    );
    if (next.files.length === 0) onOpenChange(false);
  };

  // dc:subject keywords from paired sidecars — SUGGESTED only, never
  // auto-applied (tags stay a human decision).
  const [sidecarKeywords, setSidecarKeywords] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    const xmps = files.flatMap((file) => {
      const sidecar = sidecars?.get(file);
      return sidecar ? [sidecar] : [];
    });
    if (xmps.length === 0) {
      setSidecarKeywords([]);
      return;
    }
    let cancelled = false;
    void Promise.all(xmps.map(readSidecarMeta)).then((metas) => {
      if (cancelled) return;
      setSidecarKeywords([...new Set(metas.flatMap((meta) => meta.keywords))]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, files, sidecars]);

  const tagSuggestions = useMemo(() => {
    const query = tagInput.trim().toLowerCase();
    const unused = (tag: string) => !tags.includes(tag);
    // No query yet: surface the sidecar keywords themselves as chips.
    if (!query) return sidecarKeywords.filter(unused).slice(0, 6);
    return [...new Set([...sidecarKeywords, ...(knownTags ?? [])])]
      .filter((tag) => tag.toLowerCase().includes(query) && unused(tag))
      .slice(0, 6);
  }, [tagInput, knownTags, tags, sidecarKeywords]);

  const addTag = (tag: string) => {
    setTags((previous) => appendTag(previous, tag));
    setTagInput("");
  };

  /** Hand the batch to the manager and close — the tray takes it from here. */
  const submit = () => {
    if (!jobId) {
      toast.error("Pick a job first");
      return;
    }
    // The queue pairs by basename itself, so hand it each primary WITH its
    // sidecar (a sidecar whose primary was removed simply stays behind).
    const batchFiles = files.flatMap((file) => {
      const sidecar = sidecars?.get(file);
      return sidecar ? [file, sidecar] : [file];
    });
    manager.enqueue(batchFiles, {
      jobId,
      sheetNumber: sheetNumber || null,
      tags: withPendingTag(tags, tagInput),
      shutterAt: capturedAtOverrides,
    });
    onOpenChange(false);
  };

  const body = (
    <div className="px-4 pb-5 pt-1">
      <div className="mb-3 text-[15px] font-semibold text-white">
        Add {plural(files.length, "file")}
      </div>

      <div className="mb-3.5 flex gap-1.5 overflow-x-auto p-1">
        {files.map((file, index) => (
          <div key={index} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setPreviewIndex(index)}
              aria-label={`Preview ${file.name}`}
              className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
            >
              {previews[index] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previews[index]}
                  alt={file.name}
                  className="h-14 w-14 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg bg-[#3e3e3e] px-1 text-center text-[9px] text-[#a0a0a0]">
                  {file.name}
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => removeFile(index)}
              aria-label={`Remove ${file.name}`}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[#4e4e4e] bg-[#222222] text-white hover:bg-red-500"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
      <JobCombobox jobs={jobs ?? []} value={jobId} onChange={setJobId} />

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">
        Sheet # (optional)
      </label>
      <input
        type="text"
        inputMode="numeric"
        value={sheetNumber}
        onChange={(event) => setSheetNumber(event.target.value)}
        placeholder="e.g. 12"
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

      <div className="mt-3">
        <Button
          onClick={submit}
          disabled={files.length === 0}
          className="w-full bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {`Upload ${plural(files.length, "file")}`}
        </Button>
      </div>
    </div>
  );

  const title = "Upload photos";

  const preview = (
    <BatchPreview
      files={files}
      previews={previews}
      index={previewIndex}
      onIndexChange={setPreviewIndex}
      onClose={() => setPreviewIndex(null)}
      onRemove={removeFile}
      removeDisabled={previewIndex === null}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="border-[#4e4e4e] bg-[#2e2e2e]">
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          {body}
          {preview}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-none bg-[#2e2e2e] p-0 sm:max-w-md">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {body}
        {preview}
      </DialogContent>
    </Dialog>
  );
}
