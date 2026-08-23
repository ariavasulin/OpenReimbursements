// Resolves the one <source> the lightbox should hand a video slide, or
// declares the video unplayable so the UI can show a download card instead
// of a dead player.
//
// Why relabel quicktime: iPhone .MOV files are H.264/AAC in a QuickTime
// container, and browsers that decode them (Safari, and Chrome in practice)
// accept them served as video/mp4 — while `canPlayType("video/quicktime")`
// returns "" almost everywhere, hiding videos that would have played.

import type { PhotoRow } from "./types";

export type VideoSource = { src: string; type: string } | { unplayable: true };

/** `HTMLMediaElement.canPlayType`: "" | "maybe" | "probably". */
type CanPlay = (type: string) => string;

export function videoSource(
  row: Pick<PhotoRow, "mime_type" | "original_path" | "playback_path">,
  publicUrl: (path: string) => string,
  canPlayType: CanPlay
): VideoSource {
  // A transcoded MP4 rendition, when one exists, plays everywhere — use it
  // unconditionally.
  if (row.playback_path) {
    return { src: publicUrl(row.playback_path), type: "video/mp4" };
  }
  const mime = row.mime_type ?? "";
  const type =
    mime === "video/quicktime" || mime === "video/mp4" || mime === ""
      ? "video/mp4"
      : mime;
  if (canPlayType(type) !== "") {
    return { src: publicUrl(row.original_path), type };
  }
  return { unplayable: true };
}
