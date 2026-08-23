// Resolves the one <source> the lightbox should hand a video slide, or
// declares the video unplayable so the UI can show a download card instead
// of a dead player. Pure: the caller injects publicUrl and canPlayType.
//
// Why relabel quicktime: iPhone .MOV files are H.264/AAC in a QuickTime
// container, and browsers that decode them (Safari, and Chrome in practice)
// accept them served as video/mp4 — while `canPlayType("video/quicktime")`
// returns "" almost everywhere, hiding videos that would have played.

import type { PhotoRow } from "./types";

export type VideoSource = { src: string; type: string } | { unplayable: true };

/** `HTMLMediaElement.canPlayType`: "" | "maybe" | "probably". */
type CanPlay = (type: string) => string;

/** The MIME label to probe/serve for this row's container. */
export function containerMime(
  row: Pick<PhotoRow, "mime_type" | "original_name">
): string {
  const m = row.mime_type ?? "";
  if (m === "video/quicktime" || m === "video/mp4" || m === "") {
    return "video/mp4";
  }
  return m;
}

export function videoSource(
  row: Pick<
    PhotoRow,
    "mime_type" | "original_name" | "original_path" | "playback_path"
  >,
  publicUrl: (path: string) => string,
  canPlayType: CanPlay
): VideoSource {
  // A transcoded MP4 rendition, when one exists, plays everywhere — use it
  // unconditionally. (The column arrives with the transcode work; until
  // then rows carry no playback_path and this is never taken.)
  if (row.playback_path) {
    return { src: publicUrl(row.playback_path), type: "video/mp4" };
  }
  const type = containerMime(row);
  if (canPlayType(type) !== "") {
    return { src: publicUrl(row.original_path), type };
  }
  return { unplayable: true };
}
