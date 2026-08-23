import { describe, expect, it } from "vitest";
import { videoSource } from "./video-source";

const publicUrl = (path: string) => `https://cdn.test/${path}`;

const row = (
  overrides: Partial<Parameters<typeof videoSource>[0]> = {}
): Parameters<typeof videoSource>[0] => ({
  mime_type: "video/quicktime",
  original_path: "originals/u1/p1/IMG_0001.MOV",
  playback_path: null,
  ...overrides,
});

describe("videoSource", () => {
  it("streams the original labeled video/mp4 when the browser can play it", () => {
    expect(videoSource(row(), publicUrl, () => "maybe")).toEqual({
      src: "https://cdn.test/originals/u1/p1/IMG_0001.MOV",
      type: "video/mp4",
    });
  });

  it("keeps a non-quicktime container's own MIME type", () => {
    const r = row({ mime_type: "video/webm" });
    expect(videoSource(r, publicUrl, () => "probably")).toEqual({
      src: "https://cdn.test/originals/u1/p1/IMG_0001.MOV",
      type: "video/webm",
    });
  });

  it("declares the video unplayable when canPlayType says no", () => {
    expect(videoSource(row(), publicUrl, () => "")).toEqual({
      unplayable: true,
    });
  });

  it("prefers playback_path with video/mp4 even where canPlayType says no", () => {
    const r = row({ playback_path: "derived/u1/p1_playback.mp4" });
    expect(videoSource(r, publicUrl, () => "")).toEqual({
      src: "https://cdn.test/derived/u1/p1_playback.mp4",
      type: "video/mp4",
    });
  });
});
