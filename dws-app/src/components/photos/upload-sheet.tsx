"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import SheetShell from "@/components/photos/sheet-shell";
import PhotoMetaFields, {
  EMPTY_META,
  type PhotoMeta,
} from "@/components/photos/photo-meta-fields";
import BatchPreview from "@/components/photos/batch-preview";
import { useUploadManager } from "@/lib/photos/upload-manager";
import {
  addTagToMeta,
  appendTag,
  tagSuggestions,
  toTagPairs,
} from "@/lib/photos/tags";
import { usePhotoTags } from "@/lib/photos/api";
import { readSidecarMeta } from "@/lib/photos/sidecar";
import { plural } from "@/lib/photos/format";
import { nextPreviewIndex } from "@/lib/photos/batch";

// One job, sheet, and tag set per batch, inside SheetShell (Drawer on mobile,
// Dialog on desktop). The batch is copied into local state so files can be
// removed before it is handed to the upload manager; from there the tray owns
// the upload and its progress, and this sheet just closes.

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
  const manager = useUploadManager();
  const [meta, setMeta] = useState<PhotoMeta>({
    ...EMPTY_META,
    jobId: defaultJobId ?? "",
  });
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const previewsRef = useRef<(string | null)[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Reset per new batch.
  useEffect(() => {
    if (open) {
      setMeta({ ...EMPTY_META, jobId: defaultJobId ?? "" });
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
    // files and previews are indexed by the same position, so drop from both.
    const drop = <T,>(list: T[]) => list.filter((_, i) => i !== index);
    const nextFiles = drop(files);
    const nextPreviews = drop(previews);
    setFiles(nextFiles);
    previewsRef.current = nextPreviews;
    setPreviews(nextPreviews);
    setPreviewIndex((current) =>
      current === null
        ? null
        : nextPreviewIndex(current, index, nextFiles.length)
    );
    if (nextFiles.length === 0) onOpenChange(false);
  };

  // dc:subject keywords from paired sidecars — SUGGESTED only, never
  // auto-applied (tags stay a human decision). Keyed by primary file and read
  // once per batch, so removing a thumbnail never re-reads the other .xmps.
  const [keywordsByFile, setKeywordsByFile] = useState<Map<File, string[]>>(
    new Map()
  );
  useEffect(() => {
    if (!open) return;
    const pairs = sidecars ? [...sidecars] : [];
    if (pairs.length === 0) {
      setKeywordsByFile(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      pairs.map(async ([primary, xmp]) => {
        const sidecarMeta = await readSidecarMeta(xmp);
        return [primary, sidecarMeta.keywords] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setKeywordsByFile(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [open, sidecars]);

  const { data: knownTags } = usePhotoTags(open);

  // What the sidecars add on top of PhotoMetaFields' own suggestions: the same
  // matching rule, minus the tags its TagInput is already showing. With no
  // query typed TagInput shows nothing, so the keywords themselves surface.
  const sidecarSuggestions = useMemo(() => {
    const alreadyShown = new Set(
      tagSuggestions(toTagPairs(knownTags ?? []), meta.tagInput, meta.tags)
    );
    const query = meta.tagInput.trim().toLowerCase();
    return [...new Set(files.flatMap((file) => keywordsByFile.get(file) ?? []))]
      .filter(
        (tag) =>
          !meta.tags.includes(tag) &&
          !alreadyShown.has(tag) &&
          tag.toLowerCase().includes(query)
      )
      .slice(0, 6);
  }, [files, keywordsByFile, knownTags, meta.tagInput, meta.tags]);

  /** Hand the batch to the manager and close — the tray takes it from here. */
  const submit = () => {
    if (!meta.jobId) {
      toast.error("Pick a job first");
      return;
    }
    // Pairing was decided at pick time; a sidecar whose primary was removed
    // from the strip simply stays behind.
    manager.enqueue(
      files.map((file) => ({ file, sidecar: sidecars?.get(file) })),
      {
        jobId: meta.jobId,
        sheetNumber: meta.sheetNumber.trim() || null,
        tags: appendTag(meta.tags, meta.tagInput),
        shutterAt: capturedAtOverrides,
      }
    );
    onOpenChange(false);
  };

  const header = (
    <div className="mb-2 flex gap-1.5 overflow-x-auto p-1">
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
            className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-[#4e4e4e] bg-[#222222] text-white hover:bg-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );

  const fields = (
    <>
      <PhotoMetaFields value={meta} onChange={setMeta} enabled={open} />

      {sidecarSuggestions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {sidecarSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setMeta((prev) => addTagToMeta(prev, tag))}
              className="rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-2.5 py-1 text-xs text-[#d0d0d0] hover:border-[#2680FC]"
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <BatchPreview
        files={files}
        previews={previews}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        onClose={() => setPreviewIndex(null)}
        onRemove={removeFile}
        removeDisabled={previewIndex === null}
      />
    </>
  );

  const footer = (
    <Button
      onClick={submit}
      disabled={files.length === 0}
      className="w-full bg-[#2680FC] text-white hover:bg-[#1a6fd8]"
      size="lg"
    >
      {`Upload ${plural(files.length, "file")}`}
    </Button>
  );

  return (
    <SheetShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Add ${plural(files.length, "file")}`}
      header={header}
      footer={footer}
    >
      {fields}
    </SheetShell>
  );
}
