import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeDerivatives,
  POSTER_SEEK_SECS,
  THUMB_MAX_DIM,
  PREVIEW_MAX_DIM,
} from "./derivatives";

// Browser decode/canvas APIs are stubbed; Node has none.

interface FakeCanvas {
  width: number;
  height: number;
}

/** Stub OffscreenCanvas; every canvas constructed lands in `canvases`. */
function installOffscreenCanvas(canvases: FakeCanvas[]) {
  class OffscreenCanvasMock {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      canvases.push(this);
    }
    getContext(kind: string) {
      return kind === "2d" ? { drawImage: () => {} } : null;
    }
    async convertToBlob(options?: { type?: string }) {
      return new Blob([`${this.width}x${this.height}`], {
        type: options?.type ?? "image/png",
      });
    }
  }
  vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
}

function installCanvasMocks(bitmap: { width: number; height: number }) {
  const canvases: FakeCanvas[] = [];

  // Emulate `from-image`: the returned bitmap is already orientation-
  // corrected, so its dimensions are what the canvas math sees.
  const createImageBitmapMock = vi.fn(async () => ({
    width: bitmap.width,
    height: bitmap.height,
    close: vi.fn(),
  }));
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  installOffscreenCanvas(canvases);

  return { canvases, createImageBitmapMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeDerivatives", () => {
  it("makes a ~400px thumb and ~2048px preview from a landscape image", async () => {
    const { canvases, createImageBitmapMock } = installCanvasMocks({
      width: 4000,
      height: 3000,
    });
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(createImageBitmapMock).toHaveBeenCalledWith(file, {
      imageOrientation: "from-image",
    });
    expect(result).not.toBeNull();
    expect(result!.thumb.type).toBe("image/webp");
    expect(result!.preview.type).toBe("image/webp");
    // Longest side capped, aspect preserved.
    expect(canvases[0]).toMatchObject({ width: THUMB_MAX_DIM, height: 300 });
    expect(canvases[1]).toMatchObject({
      width: PREVIEW_MAX_DIM,
      height: 1536,
    });
  });

  it("keeps a rotated (portrait after EXIF orientation) photo portrait", async () => {
    // A phone photo stored landscape with EXIF orientation 6 decodes to a
    // portrait bitmap under from-image — the derivatives must stay portrait.
    const { canvases } = installCanvasMocks({ width: 3000, height: 4000 });
    const file = new File([new Uint8Array(8)], "rotated.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(canvases[0]).toMatchObject({ width: 300, height: THUMB_MAX_DIM });
    expect(canvases[1]).toMatchObject({
      width: 1536,
      height: PREVIEW_MAX_DIM,
    });
  });

  it("never upscales images smaller than the target", async () => {
    const { canvases } = installCanvasMocks({ width: 320, height: 240 });
    const file = new File([new Uint8Array(8)], "small.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(canvases[0]).toMatchObject({ width: 320, height: 240 }); // thumb
    expect(canvases[1]).toMatchObject({ width: 320, height: 240 }); // preview
  });

  it("returns null when the file can't be decoded", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("undecodable");
      })
    );
    const file = new File([new Uint8Array(8)], "photo.heic", {
      type: "image/heic",
    });
    expect(await makeDerivatives(file)).toBeNull();
  });

  it("returns null when no decoder exists at all", async () => {
    // No createImageBitmap stub (Node default).
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });
    expect(await makeDerivatives(file)).toBeNull();
  });
});

// --- Video posters -----------------------------------------------------

/** Emulates just enough <video> for the poster flow: metadata fires after
 * src is set, seeked fires after currentTime is set (or "error" instead). */
class FakeVideo {
  muted = false;
  playsInline = false;
  preload = "";
  videoWidth = 1920;
  videoHeight = 1080;
  duration = 42.5;
  seekedTo: number | null = null;
  failWith: "metadata" | "seek" | null = null;

  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  removeAttribute() {}
  private emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  set src(_value: string) {
    queueMicrotask(() =>
      this.emit(this.failWith === "metadata" ? "error" : "loadedmetadata")
    );
  }
  set currentTime(value: number) {
    this.seekedTo = value;
    queueMicrotask(() =>
      this.emit(this.failWith === "seek" ? "error" : "seeked")
    );
  }
}

function installVideoMocks(video: FakeVideo) {
  const canvases: FakeCanvas[] = [];
  const revoked: string[] = [];

  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "video") throw new Error(`unexpected createElement(${tag})`);
      return video;
    },
  });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake-video"),
    revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
  });
  // The poster frame is grabbed via createImageBitmap(videoElement).
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (source: unknown) => {
      const fake = source as FakeVideo;
      return { width: fake.videoWidth, height: fake.videoHeight, close: vi.fn() };
    })
  );
  installOffscreenCanvas(canvases);

  return { canvases, revoked };
}

describe("makeDerivatives (video)", () => {
  it("captures a poster ~1s in, scaled like any image, plus the duration", async () => {
    const video = new FakeVideo();
    const { canvases, revoked } = installVideoMocks(video);
    const file = new File([new Uint8Array(8)], "clip.mp4", {
      type: "video/mp4",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(result!.durationSecs).toBe(42.5);
    expect(result!.thumb.type).toBe("image/webp");
    expect(result!.preview.type).toBe("image/webp");
    expect(video.seekedTo).toBe(POSTER_SEEK_SECS);
    // 1920x1080 poster -> 400x225 thumb; preview is never upscaled.
    expect(canvases[0]).toMatchObject({ width: THUMB_MAX_DIM, height: 225 });
    expect(canvases[1]).toMatchObject({ width: 1920, height: 1080 });
    expect(revoked).toEqual(["blob:fake-video"]);
  });

  it("seeks to the midpoint of clips shorter than the 1s target", async () => {
    const video = new FakeVideo();
    video.duration = 1.2;
    installVideoMocks(video);
    const file = new File([new Uint8Array(8)], "short.mp4", {
      type: "video/mp4",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(result!.durationSecs).toBe(1.2);
    expect(video.seekedTo).toBeCloseTo(0.6);
  });

  it("returns null (and still revokes the object URL) when the codec can't decode", async () => {
    const video = new FakeVideo();
    video.failWith = "metadata";
    const { revoked } = installVideoMocks(video);
    const file = new File([new Uint8Array(8)], "weird.mov", {
      type: "video/quicktime",
    });

    expect(await makeDerivatives(file)).toBeNull();
    expect(revoked).toEqual(["blob:fake-video"]);
  });

  it("returns null in an environment without <video> at all", async () => {
    // Node default: no document / no createImageBitmap.
    const file = new File([new Uint8Array(8)], "clip.mp4", {
      type: "video/mp4",
    });
    expect(await makeDerivatives(file)).toBeNull();
  });
});
