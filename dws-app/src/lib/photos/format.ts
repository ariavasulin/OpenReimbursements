import type { PhotoRow } from "./types";

/** 1536 -> "1.5 KB"-style sizes; null for unknown. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 42 -> "0:42", 727 -> "12:07", 3672 -> "1:01:12". */
export function formatDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`;
}

/** "#3962 · Westbridge" — how a job is written wherever it is plain text. */
export function jobLabel(job: { job_number: string; name: string }): string {
  return `#${job.job_number} · ${job.name}`;
}

/** 1 -> "1 photo", 3 -> "3 photos". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Module-level formatters: a job page renders 100+ tiles, and constructing an
// Intl.DateTimeFormat per call is the expensive part.
const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DAY_AND_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Capture date alone — "Mar 18, 2026"; null when the date is unparseable. */
export function formatCaptureDay(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DAY.format(date);
}

/** Capture date and time — "Mar 18, 2026, 2:05 PM"; "Unknown time" if unparseable. */
export function formatCapturedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown time" : DAY_AND_TIME.format(date);
}

/** "2.4 MB JPG" from whichever of size and extension are known; null for neither. */
export function formatFileInfo(photo: PhotoRow): string | null {
  const parts: string[] = [];
  const size = formatBytes(photo.original_bytes);
  if (size) parts.push(size);
  const ext = photo.original_name?.includes(".")
    ? photo.original_name.split(".").pop()
    : photo.mime_type?.split("/")[1];
  if (ext) parts.push(ext.toUpperCase());
  return parts.length > 0 ? parts.join(" ") : null;
}
