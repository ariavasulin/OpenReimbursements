// XMP sidecar handling, pure and testable: pair sidecars with their image by
// basename at pick time (a lone .xmp is rejected — it is metadata for a
// specific image, never evidence on its own), and read the two things we use
// from the packet (capture date, keyword suggestions).
//
// Parsing is a small regex pass over the XML: exifr can't open a bare XMP
// packet (it only recognizes image containers), and the two fields we need
// appear in both attribute and element form in Lightroom-style sidecars.

import { classifyFile, extensionOf, type Classified } from "./classify";

/** One queue-item-to-be: an uploadable file, optionally with its .xmp. */
export interface Pair {
  primary: Classified;
  sidecar?: Classified;
}

export interface Rejected {
  name: string;
  /** Human-readable, toast-ready: `${name} ${reason}`. */
  reason: string;
}

const basename = (name: string) => {
  const ext = extensionOf(name);
  return (ext ? name.slice(0, -(ext.length + 1)) : name).toLowerCase();
};

/**
 * Group a picked batch: every non-sidecar file becomes a primary; each .xmp
 * attaches to the image sharing its basename (case-insensitive). Only images
 * own sidecars; an unmatched or duplicate .xmp is rejected with a reason.
 */
export function pairByBasename(files: File[]): {
  pairs: Pair[];
  rejected: Rejected[];
} {
  const classified = files.map(classifyFile);
  const primaries = new Map<string, Pair>();
  const pairs: Pair[] = [];
  for (const c of classified) {
    if (c.kind === "sidecar") continue;
    const pair: Pair = { primary: c };
    pairs.push(pair);
    if (c.kind === "image") primaries.set(basename(c.file.name), pair);
  }
  const rejected: Rejected[] = [];
  for (const c of classified) {
    if (c.kind !== "sidecar") continue;
    const owner = primaries.get(basename(c.file.name));
    if (!owner || owner.sidecar) {
      rejected.push({
        name: c.file.name,
        reason: `needs ${basename(c.file.name)}.<image> in the same upload`,
      });
    } else {
      owner.sidecar = c;
    }
  }
  return { pairs, rejected };
}

export interface SidecarMeta {
  capturedAt: Date | null;
  keywords: string[];
}

/** First match of an XMP property in attribute or element form. */
function xmpValue(text: string, tag: string): string | null {
  const attribute = new RegExp(`${tag}="([^"]+)"`).exec(text);
  if (attribute) return attribute[1];
  const element = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`).exec(text);
  return element ? element[1].trim() : null;
}

/**
 * Capture date (`exif:DateTimeOriginal`, then `xmp:CreateDate`) and
 * `dc:subject` keywords from an XMP sidecar. Never throws — a malformed
 * packet just yields nothing.
 */
export async function readSidecarMeta(xmp: File): Promise<SidecarMeta> {
  try {
    const text = await xmp.text();
    const raw =
      xmpValue(text, "exif:DateTimeOriginal") ??
      xmpValue(text, "xmp:CreateDate");
    const capturedAt =
      raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : null;
    const subject = /<dc:subject>([\s\S]*?)<\/dc:subject>/.exec(text)?.[1] ?? "";
    const keywords = [...subject.matchAll(/<rdf:li[^>]*>([^<]+)<\/rdf:li>/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    return { capturedAt, keywords };
  } catch {
    return { capturedAt: null, keywords: [] };
  }
}
