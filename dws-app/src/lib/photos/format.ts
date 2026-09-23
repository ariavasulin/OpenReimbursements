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

/** A photo's name as people see it: the name someone gave it, else the uploaded filename. */
export function photoName(photo: { display_name?: string | null; original_name: string | null }): string | null {
  return photo.display_name || photo.original_name || null;
}

/**
 * The filename a download saves as: the photo's name, keeping the uploaded file's
 * extension when the new name has none ("Kitchen before" -> "Kitchen before.jpg").
 */
export function downloadName(photo: { display_name?: string | null; original_name: string | null }): string | null {
  if (!photo.display_name) return photo.original_name;
  const ext = photo.original_name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0];
  return ext && !photo.display_name.toLowerCase().endsWith(ext.toLowerCase())
    ? `${photo.display_name}${ext}`
    : photo.display_name;
}

/** What stands where a project name would be, for a photo that has none. */
export const NO_PROJECT = "No project";

/** "#3962 · Westbridge" — how a job is written wherever it is plain text. */
export function jobLabel(job: { job_number: string; name: string }): string {
  return `#${job.job_number} · ${job.name}`;
}

/** A photo's project in words: its label, "No project", or "a project" when the job was not embedded. */
export function projectName(job: { job_number: string; name: string } | null, jobId: string | null): string {
  return job ? jobLabel(job) : jobId === null ? NO_PROJECT : "a project";
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
