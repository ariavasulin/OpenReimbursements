"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMobile } from "@/hooks/use-mobile";
import { supabase } from "@/lib/supabaseClient";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import TagInput from "@/components/photos/tag-input";
import { fetchJobs, fetchJson, fetchTags } from "@/lib/photos/api";

// One job, sheet, and tag set per batch. Drawer on mobile, Dialog on desktop.

/** @param capturedAtOverrides Shutter times for in-app camera shots (see CameraShot). */
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
  files,
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
      setItems(
        files.map((file) => ({
          status: "pending",
          sentBytes: 0,
          totalBytes: file.size,
        }))
      );
    }
  }, [open, files, defaultJobId]);

  const previews = useMemo(
    () =>
      files.map((file) =>
        file.type.startsWith("image/") ? URL.createObjectURL(file) : null
      ),
    [files]
  );
  useEffect(() => {
    return () => {
      for (const url of previews) if (url) URL.revokeObjectURL(url);
    };
  }, [previews]);

  const tagSuggestions = useMemo(() => {
    const query = tagInput.trim().toLowerCase();
    if (!query) return [];
    return (knownTags ?? [])
      .filter(
        (tag) => tag.toLowerCase().includes(query) && !tags.includes(tag)
      )
      .slice(0, 6);
  }, [tagInput, knownTags, tags]);

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (tag && !tags.includes(tag)) setTags((previous) => [...previous, tag]);
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
      tags: tagInput.trim() ? [...tags, tagInput.trim()] : tags,
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

  const failedIndices = items
    .map((item, index) => (item.status === "failed" ? index : -1))
    .filter((index) => index >= 0);
  const pendingIndices = items
    .map((item, index) => (item.status === "pending" ? index : -1))
    .filter((index) => index >= 0);
  const doneCount = items.filter((item) => item.status === "done").length;
  const uploadStarted = items.some((item) => item.status !== "pending");
  const retrying = failedIndices.length > 0;

  const handleOpenChange = (next: boolean) => {
    if (!next && uploading) return; // don't lose an in-flight batch
    onOpenChange(next);
  };

  const body = (
    <div className="px-4 pb-5 pt-1">
      <div className="mb-3 text-[15px] font-semibold text-white">
        Add {files.length} {files.length === 1 ? "file" : "files"}
      </div>

      <div className="mb-3.5 flex gap-1.5 overflow-x-auto">
        {files.map((file, index) => (
          <div key={index} className="shrink-0">
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
          </div>
        ))}
      </div>

      {uploadStarted && (
        <UploadProgress
          files={files}
          items={items}
          onRetry={(index) => runUpload([index])}
          retryDisabled={uploading}
        />
      )}

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
      <Select value={jobId} onValueChange={setJobId} disabled={uploading}>
        <SelectTrigger className="mb-3.5 w-full border-[#3e3e3e] bg-[#3e3e3e] text-white">
          <SelectValue placeholder="Pick a job..." />
        </SelectTrigger>
        <SelectContent className="border-[#4e4e4e] bg-[#2e2e2e] text-white">
          {(jobs ?? []).map((job) => (
            <SelectItem key={job.id} value={job.id}>
              #{job.job_number} · {job.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
        className="mb-3.5 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-sm text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
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

      <div className="mt-3">
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
              : `Upload ${pendingIndices.length} ${pendingIndices.length === 1 ? "file" : "files"}`}
        </Button>
      </div>
    </div>
  );

  const title = "Upload photos";

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent className="border-[#4e4e4e] bg-[#2e2e2e]">
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-none bg-[#2e2e2e] p-0 sm:max-w-md">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}
