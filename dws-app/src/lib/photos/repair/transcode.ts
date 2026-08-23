// Runs on local files only; on Vercel that means /tmp.
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
 * the sweep never retries it (clear the columns to re-queue). The duration cap
 * sits well under the route's 300 s maxDuration, because that same window also
 * has to cover the download, the probe, the poster extraction and the upload —
 * only the transcode itself is bounded here. */
export const CAP = { bytes: 200 * 1024 * 1024, secs: 120 };

/** Kill switch: transcodes are planned only when PHOTOS_TRANSCODE=1. */
export const ENABLED = () => process.env.PHOTOS_TRANSCODE === "1";

/** Why a clip won't be transcoded, or null when it's within the caps. An
 * unknown duration (`null`, see parseDuration) is a skip, not a pass: with no
 * duration the only remaining bound is the size cap, and at a low bitrate
 * 200 MB is far more footage than the function has time for. */
export function capReason(
  bytes: number,
  durationSecs: number | null
): string | null {
  if (bytes > CAP.bytes) return `over ${CAP.bytes} bytes`;
  if (durationSecs === null) return "unknown duration";
  if (durationSecs > CAP.secs) return `over ${CAP.secs}s`;
  return null;
}

/** Seconds from the `Duration: HH:MM:SS.ss` line ffmpeg prints to stderr, or
 * null when the duration is unknown — ffmpeg reports N/A for streams with no
 * container duration (raw H.264, MediaRecorder .webm, interrupted
 * recordings), and says nothing we recognize for input it can't read. Unknown
 * is not 0: a real `Duration: 00:00:00.00` still parses to 0. */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Clip duration in seconds, or null when the container doesn't state one.
 * `ffmpeg -i <input>` with no output file reads the container header, prints
 * it, and exits non-zero ("At least one output file must be specified") — so
 * the duration arrives on the rejection's stderr. That is the whole point: it
 * never decodes a frame, which is what makes it fast on a large clip.
 */
export async function probe(
  input: string
): Promise<{ durationSecs: number | null }> {
  try {
    const { stderr } = await run(ffmpegPath!, ["-hide_banner", "-i", input]);
    return { durationSecs: parseDuration(stderr) };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? "";
    return { durationSecs: parseDuration(stderr) };
  }
}

/** One frame at `seekSecs`, written as WebP (ffmpeg picks the encoder from
 * the .webp extension) once per requested size, each scaled to fit its
 * `maxDim` (never upscaled). Every size comes out of a single invocation, so
 * the frame is decoded once however many outputs are asked for. The caller
 * passes seekSecs=0 for clips shorter than the usual 1 s seek. */
export async function poster(
  input: string,
  seekSecs: number,
  outputs: { path: string; maxDim: number }[]
) {
  await run(ffmpegPath!, [
    "-y",
    "-ss", String(seekSecs),
    "-i", input,
    ...outputs.flatMap((out) => [
      "-frames:v", "1",
      "-vf", `scale='min(${out.maxDim},iw)':-2`,
      out.path,
    ]),
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
