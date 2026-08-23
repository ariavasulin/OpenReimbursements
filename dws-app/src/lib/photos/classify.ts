// Classification by extension, not File.type: Safari leaves .xmp empty,
// browsers disagree on containers, and the extension table is what makes the
// stored object's Content-Type canonical (rewrap below). Pure — no DOM.

import type { PhotoKind } from "./types";

/** Pick-time kind: PhotoKind plus 'sidecar' (.xmp), which never becomes its
 * own row — it attaches to an image or falls back to kind 'file'. */
export type PickKind = PhotoKind | "sidecar";

export interface Classified {
  kind: PickKind;
  mime: string;
  file: File;
}

const EXT: Record<string, { kind: PickKind; mime: string }> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  heic: { kind: "image", mime: "image/heic" },
  heif: { kind: "image", mime: "image/heif" },
  tif: { kind: "image", mime: "image/tiff" },
  tiff: { kind: "image", mime: "image/tiff" },
  dng: { kind: "image", mime: "image/x-adobe-dng" },
  cr2: { kind: "image", mime: "image/x-canon-cr2" },
  nef: { kind: "image", mime: "image/x-nikon-nef" },
  arw: { kind: "image", mime: "image/x-sony-arw" },
  mov: { kind: "video", mime: "video/quicktime" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  "3gp": { kind: "video", mime: "video/3gpp" },
  webm: { kind: "video", mime: "video/webm" },
  xmp: { kind: "sidecar", mime: "application/rdf+xml" },
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function classifyFile(file: File): Classified {
  const ext = extensionOf(file.name);
  const known = EXT[ext];
  if (known) return { ...known, file };
  const t = file.type;
  if (t.startsWith("image/")) return { kind: "image", mime: t, file };
  if (t.startsWith("video/")) return { kind: "video", mime: t, file };
  return { kind: "file", mime: t || "application/octet-stream", file };
}

/** Same bytes, canonical type — so Storage records the right Content-Type
 * (the Supabase client ignores the contentType option for Blob bodies). */
export function rewrap(file: File, mime: string): File {
  return file.type === mime
    ? file
    : new File([file], file.name, { type: mime, lastModified: file.lastModified });
}
