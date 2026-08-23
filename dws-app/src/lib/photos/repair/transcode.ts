// Thin ffmpeg wrappers for the repair sweep's video actions: probe a clip's
// duration, pull a poster frame, and make the H.264/AAC playback rendition
// Chrome and Firefox can play. Pure process-spawning — the route
// (app/api/photos/repair/route.ts) owns storage downloads/uploads and row
// updates. Runs on local files only; on Vercel that means /tmp.
//
// Duration comes from ffmpeg's own header dump rather than ffprobe:
// ffprobe-static ships every platform's binary (345 MB installed, 62 MB for
// linux/x64 alone) against a 250 MB uncompressed function limit, and the one
// number we need is already in the stderr ffmpeg prints before it runs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const run = promisify(execFile);

/** Transcode caps: anything over is skipped with playback_skipped_reason so
 * the sweep never retries it (clear the columns to re-queue). Sized so one
 * clip transcodes comfortably inside the route's 300 s maxDuration. */
export const CAP = { bytes: 200 * 1024 * 1024, secs: 300 };

/** Phase 6 kill switch: transcodes are planned only when PHOTOS_TRANSCODE=1. */
export const ENABLED = () => process.env.PHOTOS_TRANSCODE === "1";

/** Why a clip won't be transcoded, or null when it's within the caps. */
export function capReason(bytes: number, durationSecs: number): string | null {
  if (bytes > CAP.bytes) return `over ${CAP.bytes} bytes`;
  if (durationSecs > CAP.secs) return `over ${CAP.secs}s`;
  return null;
}

/** Seconds from the `Duration: HH:MM:SS.ss` line ffmpeg prints to stderr, or
 * 0 when it reports N/A (streams with no container duration) or says nothing
 * we recognize. Exported for tests — the parsing is the fragile part. */
export function parseDuration(stderr: string): number {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Clip duration in seconds. `ffmpeg -i <input>` with no output file reads the
 * container header, prints it, and exits non-zero ("At least one output file
 * must be specified") — so the duration arrives on the rejection's stderr.
 * That is the whole point: it never decodes a frame, which is what makes it
 * fast on a large clip.
 */
export async function probe(input: string): Promise<{ durationSecs: number }> {
  try {
    const { stderr } = await run(ffmpegPath!, ["-hide_banner", "-i", input]);
    return { durationSecs: parseDuration(stderr) };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    return { durationSecs: parseDuration(stderr) };
  }
}

/** One frame at `seekSecs`, scaled to fit `maxDim` (never upscaled), written
 * as WebP (ffmpeg picks the encoder from the .webp extension). The caller
 * passes seekSecs=0 for clips shorter than the usual 1 s seek. */
export async function poster(
  input: string,
  output: string,
  maxDim: number,
  seekSecs: number
) {
  await run(ffmpegPath!, [
    "-y",
    "-ss", String(seekSecs),
    "-i", input,
    "-frames:v", "1",
    "-vf", `scale='min(${maxDim},iw)':-2`,
    output,
  ]);
}

/** H.264/AAC MP4 capped at 1920 px wide, +faststart so the moov atom leads
 * and playback starts before the download finishes. */
export async function transcode(input: string, output: string) {
  await run(
    ffmpegPath!,
    [
      "-y",
      "-i", input,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-vf", "scale='min(1920,iw)':-2",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      output,
    ],
    { maxBuffer: 1 << 24 }
  );
}
