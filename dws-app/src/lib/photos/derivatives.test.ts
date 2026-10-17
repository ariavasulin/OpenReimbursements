import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENCODE_QUALITY,
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

interface Encode {
  width: number;
  height: number;
  type: string;
  quality?: number;
}

/** What was drawn where, and what had been closed by then. */
interface Draw {
  target: FakeCanvas;
  source: unknown;
}

/** Stub OffscreenCanvas. Every drawing canvas lands in `canvases` (the 1x1
 * WebP probe is left out so indexes stay preview, thumb), every draw in
 * `draws`, and every encode in `encodes`. Like a real browser, a type it
 * cannot encode comes back as PNG; WebKit is
 * `{ encodable: ["image/png", "image/jpeg"] }`. */
function installOffscreenCanvas(
  canvases: FakeCanvas[],
  {
    encodable,
    encodes = [],
    draws = [],
    onEncode,
  }: { encodable?: string[]; encodes?: Encode[]; draws?: Draw[]; onEncode?: () => void } = {}
) {
  class OffscreenCanvasMock {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      if (width * height > 1) canvases.push(this);
    }
    getContext(kind: string) {
      return kind === "2d"
        ? { drawImage: (source: unknown) => draws.push({ target: this, source }) }
        : null;
    }
    async convertToBlob(options?: { type?: string; quality?: number }) {
      if (this.width * this.height > 1) onEncode?.();
      const asked = options?.type ?? "image/png";
      const type = !encodable || encodable.includes(asked) ? asked : "image/png";
      encodes.push({ width: this.width, height: this.height, type: asked, quality: options?.quality });
      return new Blob([`${this.width}x${this.height}`], { type });
    }
  }
  vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
}

function installCanvasMocks(bitmap: {
  width: number;
  height: number;
  /** Stored with an EXIF rotation (e.g. orientation 6): only
   * `imageOrientation: "from-image"` decodes it with the sides swapped. */
  exifRotated?: boolean;
}, encodable?: string[]) {
  const canvases: FakeCanvas[] = [];
  const encodes: Encode[] = [];
  const draws: Draw[] = [];
  const decoded: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  /** Per encode: whether every decoded bitmap was already closed. */
  const closedAtEncode: boolean[] = [];

  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (_source: unknown, options?: ImageBitmapOptions) => {
      const rotated =
        bitmap.exifRotated && options?.imageOrientation === "from-image";
      const made = {
        width: rotated ? bitmap.height : bitmap.width,
        height: rotated ? bitmap.width : bitmap.height,
        close: vi.fn(),
      };
      decoded.push(made);
      return made;
    })
  );
  installOffscreenCanvas(canvases, {
    encodable,
    encodes,
    draws,
    onEncode: () => closedAtEncode.push(decoded.every((b) => b.close.mock.calls.length > 0)),
  });

  return { canvases, encodes, draws, decoded, closedAtEncode };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeDerivatives", () => {
  it("makes a ~640px thumb and ~2048px preview from a landscape image", async () => {
    const { canvases } = installCanvasMocks({ width: 4000, height: 3000 });
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(result!.thumb.type).toBe("image/webp");
    expect(result!.preview.type).toBe("image/webp");
    // Longest side capped, aspect preserved.
    expect(canvases[0]).toMatchObject({
      width: PREVIEW_MAX_DIM,
      height: 1536,
    });
    expect(canvases[1]).toMatchObject({ width: THUMB_MAX_DIM, height: 480 });
  });

  it("decodes once: the thumb is drawn from the preview, after the full frame is freed", async () => {
    const { canvases, draws, decoded, closedAtEncode } = installCanvasMocks({
      width: 8000,
      height: 6000,
    });
    const file = new File([new Uint8Array(8)], "48mp.jpg", {
      type: "image/jpeg",
    });

    expect(await makeDerivatives(file)).not.toBeNull();

    expect(decoded).toHaveLength(1);
    // The full frame is drawn once, into the preview; the thumb's source is
    // the preview canvas, not the full frame.
    expect(draws.map((d) => [d.target, d.source])).toEqual([
      [canvases[0], decoded[0]],
      [canvases[1], canvases[0]],
    ]);
    // The ~190 MB decode is closed before any encoding begins.
    expect(closedAtEncode.length).toBeGreaterThan(0);
    expect(closedAtEncode.every(Boolean)).toBe(true);
  });

  it("keeps a rotated (portrait after EXIF orientation) photo portrait", async () => {
    // A phone photo stored landscape with EXIF orientation 6 decodes to a
    // portrait bitmap only under from-image — the derivatives must be portrait.
    const { canvases } = installCanvasMocks({
      width: 4000,
      height: 3000,
      exifRotated: true,
    });
    const file = new File([new Uint8Array(8)], "rotated.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(canvases[0]).toMatchObject({
      width: 1536,
      height: PREVIEW_MAX_DIM,
    });
    expect(canvases[1]).toMatchObject({ width: 480, height: THUMB_MAX_DIM });
  });

  it("never upscales images smaller than the target", async () => {
    const { canvases } = installCanvasMocks({ width: 320, height: 240 });
    const file = new File([new Uint8Array(8)], "small.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(canvases[0]).toMatchObject({ width: 320, height: 240 }); // preview
    expect(canvases[1]).toMatchObject({ width: 320, height: 240 }); // thumb
  });

  it("falls back to JPEG at quality 0.8 where WebP comes back as PNG (WebKit)", async () => {
    // Every iOS browser: convertToBlob({type: "image/webp"}) silently
    // returns a PNG ~15x the size. The derivative must never be that PNG.
    const { encodes } = installCanvasMocks(
      { width: 4000, height: 3000 },
      ["image/png", "image/jpeg"]
    );
    const file = new File([new Uint8Array(8)], "IMG_0001.jpg", {
      type: "image/jpeg",
    });

    const result = await makeDerivatives(file);

    expect(result).not.toBeNull();
    expect(result!.thumb.type).toBe("image/jpeg");
    expect(result!.preview.type).toBe("image/jpeg");
    // Only the 1x1 probe ever asked for WebP; no full-size PNG was encoded.
    const sized = encodes.filter((e) => e.width * e.height > 1);
    expect(sized.map((e) => e.type)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(sized.every((e) => e.quality === ENCODE_QUALITY)).toBe(true);
    expect(ENCODE_QUALITY).toBe(0.8);
  });

  it("asks whether WebP encodes only once per canvas kind", async () => {
    const { encodes } = installCanvasMocks({ width: 4000, height: 3000 });
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });

    await makeDerivatives(file);
    await makeDerivatives(file);

    expect(encodes.filter((e) => e.width * e.height === 1)).toHaveLength(1);
    expect(encodes.filter((e) => e.width * e.height > 1).map((e) => e.type))
      .toEqual(Array(4).fill("image/webp"));
  });

  it("re-encodes as JPEG when the WebP probe passed but a full-size WebP did not", async () => {
    const { encodes } = installCanvasMocks({ width: 4000, height: 3000 });
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });
    // The probe has already run (and passed) for this canvas class; now the
    // class starts answering WebP requests with PNG.
    await makeDerivatives(file);
    const Mock = globalThis.OffscreenCanvas as unknown as {
      prototype: { convertToBlob(o?: { type?: string }): Promise<Blob> };
    };
    const original = Mock.prototype.convertToBlob;
    Mock.prototype.convertToBlob = async function (o) {
      const blob = await original.call(this, o);
      return o?.type === "image/webp" ? new Blob([blob], { type: "image/png" }) : blob;
    };
    encodes.length = 0;

    const result = await makeDerivatives(file);

    expect(result!.thumb.type).toBe("image/jpeg");
    expect(result!.preview.type).toBe("image/jpeg");
  });

  it("returns null rather than store a PNG when neither WebP nor JPEG encodes", async () => {
    installCanvasMocks({ width: 4000, height: 3000 }, ["image/png"]);
    const file = new File([new Uint8Array(8)], "photo.jpg", {
      type: "image/jpeg",
    });

    expect(await makeDerivatives(file)).toBeNull();
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
    // 1920x1080 poster -> 640x360 thumb; preview is never upscaled.
    expect(canvases[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(canvases[1]).toMatchObject({ width: THUMB_MAX_DIM, height: 360 });
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

  it("makes a JPEG poster where the browser cannot encode WebP (iPhone video)", async () => {
    const video = new FakeVideo();
    vi.stubGlobal("document", { createElement: () => video });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1920, height: 1080, close: vi.fn() })));
    installOffscreenCanvas([], { encodable: ["image/png", "image/jpeg"] });
    const file = new File([new Uint8Array(8)], "clip.mov", { type: "video/quicktime" });

    const result = await makeDerivatives(file);

    expect(result!.thumb.type).toBe("image/jpeg");
    expect(result!.preview.type).toBe("image/jpeg");
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
