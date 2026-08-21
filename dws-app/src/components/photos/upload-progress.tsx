"use client";

import { RotateCw } from "lucide-react";
import { formatBytes } from "@/lib/photos/format";

// Per-file progress list for a running (or partially failed) batch. Failed
// rows get an unmissable Retry; done rows stay done — a partial batch keeps
// its successes (4 of 5 photos landing on jobsite LTE is a success to keep).

export type UploadItemStatus = "pending" | "uploading" | "done" | "failed";

export interface UploadItem {
  status: UploadItemStatus;
  sentBytes: number;
  totalBytes: number;
  error?: string;
}

interface UploadProgressProps {
  files: File[];
  items: UploadItem[];
  /** Retry one failed file. Disabled while another upload is in flight. */
  onRetry(index: number): void;
  retryDisabled?: boolean;
}

function percent(item: UploadItem): number {
  if (item.status === "done") return 100;
  if (item.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((item.sentBytes / item.totalBytes) * 100));
}

export default function UploadProgress({
  files,
  items,
  onRetry,
  retryDisabled,
}: UploadProgressProps) {
  return (
    <div className="mb-3.5 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
      {files.map((file, index) => {
        const item = items[index];
        const value = percent(item);
        return (
          <div
            key={index}
            className={`rounded-lg border px-3 py-2 ${
              item.status === "failed"
                ? "border-red-500/70 bg-red-500/10"
                : "border-[#3e3e3e] bg-[#3e3e3e]"
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs text-white">
                    {file.name}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] ${
                      item.status === "done"
                        ? "text-[#4ade80]"
                        : item.status === "failed"
                          ? "text-red-400"
                          : "text-[#a0a0a0]"
                    }`}
                  >
                    {item.status === "done" && "Done"}
                    {item.status === "pending" && "Waiting"}
                    {item.status === "failed" && "Failed"}
                    {item.status === "uploading" &&
                      (item.sentBytes > 0
                        ? `${formatBytes(item.sentBytes)} / ${formatBytes(item.totalBytes)}`
                        : "Uploading...")}
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#222222]">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      item.status === "done"
                        ? "bg-[#4ade80]"
                        : item.status === "failed"
                          ? "bg-red-500"
                          : "bg-[#2680FC]"
                    }`}
                    style={{ width: `${value}%` }}
                  />
                </div>
                {item.status === "failed" && item.error && (
                  <div className="mt-1 truncate text-[10px] text-red-400">
                    {item.error}
                  </div>
                )}
              </div>
              {item.status === "failed" && (
                <button
                  type="button"
                  onClick={() => onRetry(index)}
                  disabled={retryDisabled}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-[#2680FC] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1a6fd8] disabled:opacity-50"
                >
                  <RotateCw className="h-3 w-3" />
                  Retry
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
