"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMobile } from "@/hooks/use-mobile";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import SheetShell from "@/components/photos/sheet-shell";
import JobCombobox from "@/components/photos/job-combobox";
import BatchPreview from "@/components/photos/batch-preview";
import {
  createResumableUpload,
  uploadOne,
  type FinalizePayload,
  type UploadDeps,
  type UploadResult,
} from "@/lib/photos/upload";
import { extractCapturedAt } from "@/lib/photos/exif";
import UploadProgress, {
  type UploadItem,
} from "@/components/photos/upload-progress";
import TagInput, { appendTag, withPendingTag } from "@/components/photos/tag-input";
import { fetchJobs, fetchJson, fetchTags } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { canRemove, nextPreviewIndex, removeAt } from "@/lib/photos/batch";

// One job, sheet, and tag set per batch, inside SheetShell (Drawer on mobile,
// Dialog on desktop). The batch is copied into local state so files can be
// removed before upload.

function makePreviews(files: File[]): (string | null)[] {
  return files.map((file) =>
    file.type.startsWith("image/") ? URL.createObjectURL(file) : null
  );
}

function revokePreviews(previews: (string | null)[]) {
  for (const url of previews) if (url) URL.revokeObjectURL(url);
}

function buildUploadDeps(capturedAtOverrides?: Map<File, Date>): UploadDeps {
  return {
    extractCapturedAt: async (file: File) =>
      capturedAtOverrides?.get(file) ?? extractCapturedAt(file),
    storage: {
      async upload(path, body, options) {
        const { error } = await supabase.storage
          .from("photos")
          .upload(path, body, options);
        return { error };
      },
    },
    resumableUpload: createResumableUpload({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      getAccessToken: async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        return session?.access_token ?? null;
      },
    }),
    async finalize(payload: FinalizePayload) {
      await fetchJson("/api/photos", "Saving failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };
}

interface UploadSheetProps {
  /** The picked/shot batch; the sheet keeps its own editable copy. */
  files: File[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Pre-selects the job when uploading from inside a job. */
  defaultJobId?: string;
  /** Called after at least one file lands, so grids can refetch. */
  onUploaded(): void;
  /** Shutter times for in-app camera shots (see CameraShot). */
  capturedAtOverrides?: Map<File, Date>;
}

export default function UploadSheet({
  files: initialFiles,
  open,
  onOpenChange,
  defaultJobId,
  onUploaded,
  capturedAtOverrides,
}: UploadSheetProps) {
  const isMobile = useMobile();
  const [jobId, setJobId] = useState(defaultJobId ?? "");
  const [sheetNumber, setSheetNumber] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const previewsRef = useRef<(string | null)[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);

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
      setItems(
        initialFiles.map((file) => ({
          status: "pending",
          sentBytes: 0,
          totalBytes: file.size,
        }))
      );
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

  const removableAt = (index: number) =>
    !uploading && !!items[index] && canRemove(items[index].status);

  const removeFile = (index: number) => {
    if (!removableAt(index)) return;
    const url = previews[index];
    if (url) URL.revokeObjectURL(url);
    const next = removeAt({ files, items, previews }, index);
    setFiles(next.files);
    setItems(next.items);
    previewsRef.current = next.previews;
    setPreviews(next.previews);
    setPreviewIndex((current) =>
      current === null
        ? null
        : nextPreviewIndex(current, index, next.files.length)
    );
    if (next.files.length === 0) onOpenChange(false);
  };

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

  const patchItem = (index: number, patch: Partial<UploadItem>) =>
    setItems((previous) => {
      const next = [...previous];
      next[index] = { ...next[index], ...patch };
      return next;
    });

  const runUpload = async (indices: number[]) => {
    if (!jobId) {
      toast.error("Pick a job first");
      return;
    }
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      toast.error("You are signed out — sign in and try again");
      return;
    }

    setUploading(true);
    const meta = {
      jobId,
      uploaderId: session.user.id,
      sheetNumber: sheetNumber || null,
      tags: withPendingTag(tags, tagInput),
    };
    const deps = buildUploadDeps(capturedAtOverrides);

    const results: UploadResult[] = [];
    for (const fileIndex of indices) {
      const file = files[fileIndex];
      patchItem(fileIndex, {
        status: "uploading",
        sentBytes: 0,
        totalBytes: file.size,
        error: undefined,
      });
      const result = await uploadOne(
        file,
        meta,
        deps,
        (sentBytes, totalBytes) =>
          setItems((previous) => {
            if (previous[fileIndex]?.sentBytes === sentBytes) return previous;
            const next = [...previous];
            next[fileIndex] = { ...next[fileIndex], sentBytes, totalBytes };
            return next;
          })
      );
      results.push(result);
      patchItem(fileIndex, { status: result.status, error: result.error });
    }
    setUploading(false);

    const failed = results.filter((result) => result.status === "failed");
    if (results.some((result) => result.status === "done")) onUploaded();
    if (failed.length === 0) {
      toast.success(
        results.length === 1
          ? "Photo uploaded"
          : `${results.length} files uploaded`
      );
      onOpenChange(false);
    } else {
      toast.error(
        `${failed.length} of ${results.length} failed — ${failed[0].error ?? "upload error"}`
      );
    }
  };

  const indicesWith = (status: UploadItem["status"]) =>
    items.flatMap((item, index) => (item.status === status ? [index] : []));
  const failedIndices = indicesWith("failed");
  const pendingIndices = indicesWith("pending");
  const doneCount = items.filter((item) => item.status === "done").length;
  const uploadStarted = items.some((item) => item.status !== "pending");
  const retrying = failedIndices.length > 0;

  const handleOpenChange = (next: boolean) => {
    if (!next && uploading) return; // don't lose an in-flight batch
    onOpenChange(next);
  };

  const header = (
    <>
      <div className="mb-3 text-[15px] font-semibold text-white">
        Add {plural(files.length, "file")}
      </div>

      <div className="mb-2 flex gap-1.5 overflow-x-auto p-1">
        {files.map((file, index) => {
          const removable = removableAt(index);
          return (
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
              {removable && (
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  aria-label={`Remove ${file.name}`}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[#4e4e4e] bg-[#222222] text-white hover:bg-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  const fields = (
    <>
      {uploadStarted && (
        <UploadProgress
          files={files}
          items={items}
          onRetry={(index) => runUpload([index])}
          retryDisabled={uploading}
        />
      )}

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
      <JobCombobox
        jobs={jobs ?? []}
        value={jobId}
        onChange={setJobId}
        disabled={uploading}
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
        disabled={uploading}
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
        disabled={uploading}
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
    </>
  );

  const footer = (
    <Button
      onClick={() => runUpload(retrying ? failedIndices : pendingIndices)}
      disabled={uploading || (!retrying && pendingIndices.length === 0)}
      className="w-full bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
      size="lg"
    >
      {uploading
        ? retrying
          ? "Uploading..."
          : `Uploading ${Math.min(doneCount + 1, files.length)} of ${files.length}...`
        : retrying
          ? `Retry ${failedIndices.length} failed`
          : `Upload ${plural(pendingIndices.length, "file")}`}
    </Button>
  );

  return (
    <SheetShell
      open={open}
      onOpenChange={handleOpenChange}
      title="Upload photos"
      header={header}
      footer={footer}
      extra={
        <BatchPreview
          files={files}
          previews={previews}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onRemove={removeFile}
          removeDisabled={previewIndex === null || !removableAt(previewIndex)}
        />
      }
    >
      {fields}
    </SheetShell>
  );
}
