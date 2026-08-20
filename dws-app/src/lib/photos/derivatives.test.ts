import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDerivatives, THUMB_MAX_DIM, PREVIEW_MAX_DIM } from "./derivatives";

// createImageBitmap / OffscreenCanvas don't exist in Node — the decode and
// canvas layers are mocked (per the TDD's test plan) and the tests assert the
// orchestration: orientation option, scaling math, undecodable -> null.

interface FakeCanvas {
  width: number;
  height: number;
}

function installCanvasMocks(bitmap: { width: number; height: number }) {
  const canvases: FakeCanvas[] = [];
  const drawCalls: unknown[][] = [];

  const createImageBitmapMock = vi.fn(
    async (_file: Blob, options?: { imageOrientation?: string }) => {
      // Emulate `from-image`: the returned bitmap is already orientation-
      // corrected, so its dimensions are what the canvas math sees.
      if (options?.imageOrientation !== "from-image") {
        throw new Error("test expects from-image orientation");
      }
      return { width: bitmap.width, height: bitmap.height, close: vi.fn() };
    }
  );
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);

  class OffscreenCanvasMock {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      canvases.push(this);
    }
    getContext(kind: string) {
      if (kind !== "2d") return null;
      return {
        drawImage: (...args: unknown[]) => drawCalls.push(args),
      };
    }
    async convertToBlob(options?: { type?: string }) {
      return new Blob([`${this.width}x${this.height}`], {
        type: options?.type ?? "image/png",
      });
    }
  }
  vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);

  return { canvases, drawCalls, createImageBitmapMock };
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
