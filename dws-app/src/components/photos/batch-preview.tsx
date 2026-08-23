"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import FullScreenSheet from "@/components/photos/full-screen-sheet";
import { formatBytes } from "@/lib/photos/format";

// Full-screen look at one pending file before it uploads.

const SWIPE_PX = 40;

interface BatchPreviewProps {
  files: File[];
  /** Object URLs for image files, index-aligned with `files`; null otherwise. */
  previews: (string | null)[];
  /** null = closed. */
  index: number | null;
  onIndexChange(index: number): void;
  onClose(): void;
  onRemove(index: number): void;
  /** True while the file at `index` is in flight or already landed. */
  removeDisabled?: boolean;
}

export default function BatchPreview({
  files,
  previews,
  index,
  onIndexChange,
  onClose,
  onRemove,
  removeDisabled,
}: BatchPreviewProps) {
  const open = index !== null && index < files.length;
  const file = open ? files[index] : null;
  const count = files.length;
  const touchStartX = useRef<number | null>(null);

  const isVideo = !!file && file.type.startsWith("video/");
  // Videos have no strip preview (the strip shows a name tile), so mint a
  // URL here just for playback. Minted in an effect, not a memo, so a
  // discarded render can't leak one.
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isVideo || !file) return;
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setVideoUrl(null);
    };
  }, [isVideo, file]);

  const go = (delta: number) => {
    if (!open || count <= 1) return;
    onIndexChange((index + delta + count) % count);
  };

  const size = file ? formatBytes(file.size) : null;
  const imageUrl = open ? previews[index] : null;

  return (
    <FullScreenSheet
      open={open}
      onClose={onClose}
      title={`Preview ${file?.name ?? ""}`}
      className="bg-black"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") go(-1);
        else if (event.key === "ArrowRight") go(1);
      }}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        if (start === null) return;
        const end = event.changedTouches[0]?.clientX;
        if (end === undefined) return;
        const delta = end - start;
        if (Math.abs(delta) < SWIPE_PX) return;
        go(delta < 0 ? 1 : -1);
      }}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-[calc(0.75rem_+_env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="rounded-full p-2 hover:bg-white/10"
        >
          <X className="h-5 w-5" />
        </button>
        {count > 1 && (
          <span className="text-xs text-[#a0a0a0]">
            {(index ?? 0) + 1} / {count}
          </span>
        )}
        <span className="w-9" />
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {file && imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        )}
        {file && isVideo && videoUrl && (
          <video
            src={videoUrl}
            playsInline
            muted
            controls
            className="max-h-full max-w-full"
          />
        )}
        {file && !imageUrl && !isVideo && (
          <div className="mx-8 break-all rounded-xl bg-[#2e2e2e] px-6 py-8 text-center text-sm text-[#d0d0d0]">
            {file.name}
          </div>
        )}
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous file"
              className="absolute left-1 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70 md:block"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next file"
              className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 p-2 hover:bg-black/70 md:block"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      <div className="px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pt-3">
        <div className="mb-3 truncate text-center text-xs text-[#a0a0a0]">
          {file?.name}
          {size && ` · ${size}`}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => open && onRemove(index)}
            disabled={removeDisabled}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-500/70 bg-red-500/10 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
            Remove
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] py-2.5 text-sm font-medium text-white hover:border-[#2680FC]"
          >
            Close
          </button>
        </div>
      </div>
    </FullScreenSheet>
  );
}
