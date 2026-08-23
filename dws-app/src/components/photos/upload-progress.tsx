"use client";

import type { ReactNode } from "react";
import { formatBytes } from "@/lib/photos/format";
import type { UploadResult } from "@/lib/photos/upload";

// Per-file progress rows for the upload tray. Callers pass a name + item per
// row plus whatever action buttons that row needs (Retry, Remove, Re-pick) —
// the rows themselves only render status. Done rows stay done — a partial batch keeps its successes
// (4 of 5 photos landing on jobsite LTE is a success to keep).

export interface UploadItem {
  status: UploadResult["status"] | "pending" | "uploading" | "interrupted";
  sentBytes: number;
  totalBytes: number;
  error?: string;
}

export interface UploadRow {
  name: string;
  item: UploadItem;
  actions?: ReactNode;
}

const STATUS_COLORS: Record<UploadItem["status"], { text: string; bar: string }> =
  {
    done: { text: "text-[#4ade80]", bar: "bg-[#4ade80]" },
    duplicate: { text: "text-[#a0a0a0]", bar: "bg-[#4ade80]" },
    failed: { text: "text-red-400", bar: "bg-red-500" },
    interrupted: { text: "text-amber-400", bar: "bg-amber-400" },
    pending: { text: "text-[#a0a0a0]", bar: "bg-[#2680FC]" },
    uploading: { text: "text-[#a0a0a0]", bar: "bg-[#2680FC]" },
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
    case "pending":
      return "Waiting";
    case "uploading":
      return item.sentBytes > 0
        ? `${formatBytes(item.sentBytes)} / ${formatBytes(item.totalBytes)}`
        : "Uploading...";
  }
}

function percent(item: UploadItem): number {
  if (item.status === "done" || item.status === "duplicate") return 100;
  if (item.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((item.sentBytes / item.totalBytes) * 100));
}

export default function UploadProgress({ rows }: { rows: UploadRow[] }) {
  return (
    <div className="mb-3.5 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
      {rows.map(({ name, item, actions }, index) => {
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
                  <span className="truncate text-xs text-white">{name}</span>
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

/** Small solid action button for a row (Retry / Re-pick). */
export function RowButton({
  onClick,
  disabled,
  children,
}: {
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded-md bg-[#2680FC] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1a6fd8] disabled:opacity-50"
    >
      {children}
    </button>
  );
}
