// The file type a person sees: one word per photo, used for grouping and the
// tile badge. A video row is "Video"; otherwise the original file name's
// extension decides (through the upload's own extension table, see
// classify.ts), then the stored MIME type; anything unrecognized is "Other".
// Pure — no DOM.

import { extensionOf, knownExtensions, mimeForExtension } from "./classify";
import type { PhotoRow } from "./types";

/** Every label, in the order groups and menus list them ("Other" last). */
export const FILE_TYPE_LABELS = ["JPEG", "HEIC", "PNG", "RAW", "Video", "Other"] as const;
export type FileTypeLabel = (typeof FILE_TYPE_LABELS)[number];

const MIME_LABEL: Record<string, FileTypeLabel> = {
  "image/jpeg": "JPEG",
  "image/heic": "HEIC",
  "image/heif": "HEIC",
  "image/png": "PNG",
  "image/x-adobe-dng": "RAW",
  "image/x-canon-cr2": "RAW",
  "image/x-canon-cr3": "RAW",
  "image/x-nikon-nef": "RAW",
  "image/x-sony-arw": "RAW",
  "image/tiff": "RAW",
};

export function fileTypeLabel(
  photo: Pick<PhotoRow, "kind" | "mime_type" | "original_name">
): FileTypeLabel {
  if (photo.kind === "video") return "Video";
  const ext = photo.original_name ? extensionOf(photo.original_name) : "";
  const fromName = mimeForExtension(ext);
  const stored = photo.mime_type?.toLowerCase() ?? "";
  const label = (fromName && MIME_LABEL[fromName]) ?? MIME_LABEL[stored];
  if (label) return label;
  return stored.startsWith("video/") ? "Video" : "Other";
}

/** A label `fileTypeLabel` reaches through the name or the MIME type (not Video or Other). */
export type NamedFileTypeLabel = Exclude<FileTypeLabel, "Video" | "Other">;

/**
 * The extensions and stored MIME types that decide each named label, so a
 * database filter (GET /api/photos `type=`) can follow `fileTypeLabel` rule for
 * rule: an extension listed here decides outright; otherwise a MIME type does.
 */
export function fileTypeSignals(): Record<NamedFileTypeLabel, { extensions: string[]; mimes: string[] }> {
  const signals: Record<NamedFileTypeLabel, { extensions: string[]; mimes: string[] }> = {
    JPEG: { extensions: [], mimes: [] },
    HEIC: { extensions: [], mimes: [] },
    PNG: { extensions: [], mimes: [] },
    RAW: { extensions: [], mimes: [] },
  };
  for (const ext of knownExtensions()) {
    const mime = mimeForExtension(ext);
    const label = mime ? MIME_LABEL[mime] : undefined;
    if (label && label !== "Video" && label !== "Other") signals[label].extensions.push(ext);
  }
  for (const [mime, label] of Object.entries(MIME_LABEL)) {
    if (label !== "Video" && label !== "Other") signals[label].mimes.push(mime);
  }
  return signals;
}
