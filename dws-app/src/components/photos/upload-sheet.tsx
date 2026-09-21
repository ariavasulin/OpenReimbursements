"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import SheetShell from "@/components/photos/sheet-shell";
import PhotoMetaFields, {
  EMPTY_META,
  type PhotoMeta,
} from "@/components/photos/photo-meta-fields";
import BatchPreview from "@/components/photos/batch-preview";
import { useUploadManager } from "@/lib/photos/upload-manager";
import { useTagChoices } from "@/components/photos/tag-dropdown";
import { addTagToMeta, appendResolvedTag } from "@/lib/photos/tags";
import type { UploadTarget } from "@/hooks/use-capture-batch";
import { readSidecarMeta } from "@/lib/photos/sidecar";
import { plural } from "@/lib/photos/format";
import { nextPreviewIndex } from "@/lib/photos/batch";
import { canDecodePreview } from "@/lib/photos/decode-limits";

// One project, album set, and tag set per batch, inside SheetShell (Drawer on
// mobile, Dialog on desktop). Every upload names a project, an album, or both
// (photo-albums Decision 3), so Upload stays disabled until one is set. The batch is copied into local state so files can be
// removed before it is handed to the upload manager; from there the tray owns
// the upload and its progress, and this sheet just closes.

function makePreviews(files: File[]): (string | null)[] {
  return files.map((file) =>
    file.type.startsWith("image/") && canDecodePreview(file) ? URL.createObjectURL(file) : null
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
  /** Pre-fills from the page the batch started on: its project or its album. */
  defaultTarget?: UploadTarget;
  /** Shutter times for in-app camera shots (see CameraShot). */
  capturedAtOverrides?: Map<File, Date>;
  /** Paired .xmp per primary image (pairByBasename ran at pick time). */
  sidecars?: Map<File, File>;
}

export default function UploadSheet({
  files: initialFiles,
  open,
  onOpenChange,
  defaultTarget,
  capturedAtOverrides,
  sidecars,
}: UploadSheetProps) {
  const manager = useUploadManager();
  const seededMeta = (): PhotoMeta => ({
    ...EMPTY_META,
    jobId: defaultTarget?.jobId ?? "",
    albums: defaultTarget?.album ? [defaultTarget.album] : [],
  });
  const [meta, setMeta] = useState<PhotoMeta>(seededMeta);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const previewsRef = useRef<(string | null)[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Reset per new batch.
  useEffect(() => {
    if (open) {
      setMeta(seededMeta());
      setPreviewIndex(null);
      setFiles(initialFiles);
      revokePreviews(previewsRef.current);
      const next = makePreviews(initialFiles);
      previewsRef.current = next;
      setPreviews(next);
    }
    // seededMeta reads defaultTarget, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFiles, defaultTarget]);
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
    void (async () => {
      const entries: [File, string[]][] = [];
      for (const [primary, xmp] of pairs) {
        if (cancelled) return;
        const sidecarMeta = await readSidecarMeta(xmp);
        entries.push([primary, sidecarMeta.keywords]);
      }
      if (cancelled) return;
      setKeywordsByFile(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sidecars]);

  const choices = useTagChoices(open);

  // Keywords the paired sidecars carry that the tag dropdown is not already
  // offering: shown as one-tap suggestions, never applied for the person.
  const sidecarSuggestions = useMemo(() => {
    const offered = new Set(choices.map((tag) => tag.toLowerCase()));
    const query = meta.tagInput.trim().toLowerCase();
    return [...new Set(files.flatMap((file) => keywordsByFile.get(file) ?? []))]
      .filter(
        (tag) =>
          !meta.tags.includes(tag) &&
          !offered.has(tag.toLowerCase()) &&
          tag.toLowerCase().includes(query)
      )
      .slice(0, 6);
  }, [files, keywordsByFile, choices, meta.tagInput, meta.tags]);

  const hasDestination = Boolean(meta.jobId) || meta.albums.length > 0;

  /** Hand the batch to the manager and close — the tray takes it from here. */
  const submit = () => {
    if (!hasDestination) return;
    // Pairing was decided at pick time; a sidecar whose primary was removed
    // from the strip simply stays behind.
    manager.enqueue(
      files.map((file) => ({ file, sidecar: sidecars?.get(file) })),
      {
        jobId: meta.jobId || null,
        albumIds: meta.albums.map((album) => album.id),
        tags: appendResolvedTag(meta.tags, meta.tagInput, choices),
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
            // The visible dot stays small beside a 56px thumbnail; the ::after
            // pad makes the tap target 44px.
            className="absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-[#4e4e4e] bg-[#222222] text-white after:absolute after:-inset-2 after:content-[''] hover:bg-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );

  const fields = (
    <>
      <p className="mb-3 text-base text-[#d0d0d0]">
        Pick a project, an album, or both.
      </p>
      <PhotoMetaFields
        value={meta}
        onChange={setMeta}
        tagChoices={choices}
        enabled={open}
      />

      {sidecarSuggestions.length > 0 && (
        <div className="mb-2 mt-2 flex flex-wrap gap-1.5">
          {sidecarSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setMeta((prev) => addTagToMeta(prev, tag))}
              className="min-h-11 rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-3 py-1 text-base text-[#d0d0d0] hover:border-[#2680FC]"
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
    <>
      {!hasDestination && (
        <p id="upload-needs-destination" className="mb-2 text-center text-base text-[#d0d0d0]">
          Choose a project or an album to turn on Upload.
        </p>
      )}
      <Button
        onClick={submit}
        disabled={files.length === 0 || !hasDestination}
        aria-describedby={hasDestination ? undefined : "upload-needs-destination"}
        className="h-auto min-h-11 w-full whitespace-normal bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
        size="lg"
      >
        {`Upload ${plural(files.length, "file")}`}
      </Button>
    </>
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
