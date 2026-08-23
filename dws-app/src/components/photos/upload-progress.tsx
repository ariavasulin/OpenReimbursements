"use client";

import type { ReactNode } from "react";
import { formatBytes } from "@/lib/photos/format";
import type { QueueItem } from "@/lib/photos/upload-queue";

export type UploadItem = Pick<
  QueueItem,
  "name" | "status" | "sentBytes" | "size" | "error"
>;

export interface UploadRow {
  item: UploadItem;
  actions?: ReactNode;
}

// #b4b4b4 on the #3e3e3e row background is ~5.2:1, clearing the 4.5:1 AA floor
// for the 10px status text (#a0a0a0 was ~4.1:1 — too dim on a phone outdoors).
const STATUS_COLORS: Record<UploadItem["status"], { text: string; bar: string }> =
  {
    done: { text: "text-[#4ade80]", bar: "bg-[#4ade80]" },
    duplicate: { text: "text-[#b4b4b4]", bar: "bg-[#4ade80]" },
    failed: { text: "text-red-400", bar: "bg-red-500" },
    interrupted: { text: "text-amber-400", bar: "bg-amber-400" },
    queued: { text: "text-[#b4b4b4]", bar: "bg-[#2680FC]" },
    uploading: { text: "text-[#b4b4b4]", bar: "bg-[#2680FC]" },
  };

function statusLabel(item: UploadItem): string {
  switch (item.status) {
    case "done":
      return "Done";
    case "duplicate":
      return "Already in this job";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "queued":
      return "Waiting";
    case "uploading":
      return item.sentBytes > 0
        ? `${formatBytes(item.sentBytes)} / ${formatBytes(item.size)}`
        : "Uploading...";
  }
}

function percent(item: UploadItem): number {
  if (item.status === "done" || item.status === "duplicate") return 100;
  if (item.size <= 0) return 0;
  return Math.min(100, Math.round((item.sentBytes / item.size) * 100));
}

export default function UploadProgress({ rows }: { rows: UploadRow[] }) {
  return (
    <div className="mb-3.5 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
      {rows.map(({ item, actions }, index) => {
        const value = percent(item);
        const colors = STATUS_COLORS[item.status];
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
                    {item.name}
                  </span>
                  <span className={`shrink-0 text-[10px] ${colors.text}`}>
                    {statusLabel(item)}
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#222222]">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${colors.bar}`}
                    style={{ width: `${value}%` }}
                  />
                </div>
                {item.status === "failed" && item.error && (
                  <div className="mt-1 truncate text-[10px] text-red-400">
                    {item.error}
                  </div>
                )}
              </div>
              {actions && (
                <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
