// The file type a person sees: one word per photo, used for grouping and the
// tile badge. A video row is "Video"; otherwise the original file name's
// extension decides (through the upload's own extension table, see
// classify.ts), then the stored MIME type; anything unrecognized is "Other".
// Pure — no DOM.

import { extensionOf, mimeForExtension } from "./classify";
import type { PhotoRow } from "./types";

/** Every label, in the order groups and menus list them ("Other" last). */
export const FILE_TYPE_LABELS = ["JPEG", "HEIC", "PNG", "RAW", "Video", "Other"] as const;
export type FileTypeLabel = (typeof FILE_TYPE_LABELS)[number];

// CR3 is not in the upload table yet, so a Chrome-uploaded .CR3 arrives as
// application/octet-stream; this entry labels it RAW by extension.
const EXTRA_EXTENSION_MIME: Record<string, string> = { cr3: "image/x-canon-cr3" };

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
  const fromName = mimeForExtension(ext) ?? EXTRA_EXTENSION_MIME[ext];
  const stored = photo.mime_type?.toLowerCase() ?? "";
  const label = (fromName && MIME_LABEL[fromName]) ?? MIME_LABEL[stored];
  if (label) return label;
  return stored.startsWith("video/") ? "Video" : "Other";
}
