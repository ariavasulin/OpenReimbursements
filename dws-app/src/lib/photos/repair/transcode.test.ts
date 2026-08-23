import { describe, expect, it } from "vitest";
import { CAP, capReason, parseDuration } from "./transcode";

// The caps decide which videos get a playback rendition and which get a
// permanent playback_skipped_reason — exact-boundary clips must transcode.
describe("capReason", () => {
  it("passes a clip exactly at both caps", () => {
    expect(capReason(CAP.bytes, CAP.secs)).toBeNull();
  });

  it("rejects one byte over the size cap", () => {
    expect(capReason(CAP.bytes + 1, 10)).toBe(`over ${CAP.bytes} bytes`);
  });

  it("rejects one second over the duration cap", () => {
    expect(capReason(10, CAP.secs + 1)).toBe(`over ${CAP.secs}s`);
  });

  it("reports the size cap first when both are over", () => {
    expect(capReason(CAP.bytes + 1, CAP.secs + 1)).toBe(
      `over ${CAP.bytes} bytes`
    );
  });

  it("skips a clip whose duration is unknown", () => {
    expect(capReason(10, null)).toBe("unknown duration");
  });

  it("still passes a genuinely zero-second clip", () => {
    expect(capReason(10, 0)).toBeNull();
  });

  it("reports the size cap first when the duration is also unknown", () => {
    expect(capReason(CAP.bytes + 1, null)).toBe(`over ${CAP.bytes} bytes`);
  });
});

describe("parseDuration", () => {
  // Real ffmpeg header output — the shape probe() actually gets on stderr.
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/input.mov':",
    "  Duration: 00:00:03.52, start: 0.000000, bitrate: 12345 kb/s",
    "At least one output file must be specified",
  ].join("\n");

  it("reads seconds from an ffmpeg header dump", () => {
    expect(parseDuration(stderr)).toBeCloseTo(3.52);
  });
  it("carries hours and minutes", () => {
    expect(parseDuration("  Duration: 01:02:03.00, start: 0")).toBe(3723);
  });
  it("reads a real zero-second duration as 0, not unknown", () => {
    expect(parseDuration("  Duration: 00:00:00.00, start: 0")).toBe(0);
  });
  it("returns null when ffmpeg reports N/A", () => {
    expect(parseDuration("  Duration: N/A, bitrate: N/A")).toBeNull();
  });
  it("returns null when there is no Duration line at all", () => {
    expect(
      parseDuration("/tmp/x: Invalid data found when processing input")
    ).toBeNull();
  });
});
