import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { DeadlineExceeded, WorkBudget } from "./deadline";
import { TRANSFORM_MAX_BYTES } from "./sweep";
import { fillImageDerivatives } from "./transforms";

/** A HEIC: the one format that goes to the transform endpoint, so these
 * tests exercise that path; sharp has its own block below. */
const row = { id: "photo", uploader_id: "employee", original_path: "employee/original.heic", mime_type: "image/heic", original_bytes: 1000 };

function fixture(changed: object | null = { id: row.id }) {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({
    eq: () => ({ is: () => ({ select: () => ({ abortSignal: () => ({ maybeSingle: () => Promise.resolve({ data: changed, error: null }) }) }) }) }),
  }));
  const admin = {
    storage: { from: () => ({
      getPublicUrl: () => ({ data: { publicUrl: "https://storage.invalid/render" } }),
      upload,
    }) },
    from: () => ({ update }),
  } as unknown as SupabaseClient;
  return { admin, upload, update };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("repair image transforms", () => {
  it("does not report success when the photo was trashed before the update", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("webp")));
    const { admin, upload } = fixture(null);
    await expect(fillImageDerivatives(admin, row)).rejects.toThrow("photo no longer active");
    expect(upload).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 503, 403, 404])("keeps render %s retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    const { admin, update } = fixture();
    await expect(fillImageDerivatives(admin, row)).rejects.toThrow(`render ${status}`);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([400, 413, 415, 422])("reports incompatible render %s as a deliberate file tile", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    const { admin, upload } = fixture();
    await expect(fillImageDerivatives(admin, row)).resolves.toEqual({ ok: false, reason: `render ${status}` });
    expect(upload).not.toHaveBeenCalled();
  });

  it("cancels a hanging body after headers under the remaining shared budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new WorkBudget();
    await budget.run(async () => { vi.setSystemTime(239_975); });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return new Response(new ReadableStream());
    }));
    const { admin, upload, update } = fixture();
    const result = fillImageDerivatives(admin, row, budget);
    const assertion = expect(result).rejects.toBeInstanceOf(DeadlineExceeded);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("bounds a rendered body even when the server omits its length", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    }))));
    const { admin, upload } = fixture();
    await expect(fillImageDerivatives(admin, row)).rejects.toThrow("render exceeds");
    expect(cancel).toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([false, true])("waits for both concurrent uploads before settling (first upload fails: %s)", async (fails) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("webp", { headers: { "content-type": "image/webp" } })));
    const { admin, upload, update } = fixture();
    let first!: (value: { error: { message: string } | null }) => void;
    let second!: (value: { error: null }) => void;
    upload.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    let settled = false;
    const outcome = fillImageDerivatives(admin, row).then(
      value => { settled = true; return value; },
      error => { settled = true; return error as Error; },
    );
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map(([path]) => path).sort()).toEqual([
      "derived/employee/photo_preview.webp", "derived/employee/photo_thumb.webp",
    ]);
    first({ error: fails ? { message: "first upload failed" } : null });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    second({ error: null });
    const result = await outcome;
    if (fails) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("first upload failed");
      expect(update).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ ok: true });
      expect(update).toHaveBeenCalledOnce();
    }
  });

  it("settles both cancelled uploads at the shared deadline without updating the row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("webp")));
    const budget = new WorkBudget(0, 25);
    const { admin, upload, update } = fixture();
    let active = 0;
    const aborted: AbortSignal[] = [];
    // The real repair client supplies this bounded fetch boundary because the
    // Storage SDK does not expose an AbortSignal on upload itself.
    upload.mockImplementation(() => budget.run(signal => new Promise((_resolve, reject) => {
      active++;
      signal.addEventListener("abort", () => {
        active--; aborted.push(signal); reject(signal.reason);
      }, { once: true });
    })));
    const result = fillImageDerivatives(admin, row, budget);
    const assertion = expect(result).rejects.toBeInstanceOf(DeadlineExceeded);
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(2);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(active).toBe(0);
    expect(aborted).toHaveLength(2);
    expect(aborted.every(signal => signal.aborted)).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("sharp renders what the browser and the transform endpoint would not", () => {
  const big = { ...row, original_path: "employee/original.jpg", mime_type: "image/jpeg", original_bytes: TRANSFORM_MAX_BYTES + 1 };
  /** The stored original, served to the renderer's download. */
  const serve = (bytes: Buffer, type: string) => vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": type, "content-length": String(bytes.byteLength) } })));
  const uploaded = async (upload: ReturnType<typeof vi.fn>) => {
    const byPath: Record<string, sharp.Metadata> = {};
    for (const [path, body] of upload.mock.calls as [string, Blob][]) {
      byPath[path] = await sharp(Buffer.from(await body.arrayBuffer())).metadata();
    }
    return byPath;
  };

  it("makes both WebPs from a JPEG over the transform cap, scaled and never enlarged", async () => {
    const original = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#4080c0" } }).jpeg().toBuffer();
    serve(original, "image/jpeg");
    const { admin, upload, update } = fixture();
    await expect(fillImageDerivatives(admin, big)).resolves.toEqual({ ok: true });
    const made = await uploaded(upload);
    expect(made["derived/employee/photo_thumb.webp"]).toMatchObject({ format: "webp", width: 640, height: 427 });
    expect(made["derived/employee/photo_preview.webp"]).toMatchObject({ format: "webp", width: 2048, height: 1365 });
    expect(update).toHaveBeenCalledOnce();
    // Write-once keys: a year of caching, labelled with the real format.
    for (const [, , options] of upload.mock.calls) {
      expect(options).toMatchObject({ contentType: "image/webp", cacheControl: "31536000", upsert: true });
    }
  });

  it("reads a TIFF, which the browser never decodes", async () => {
    const original = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#c04040" } }).tiff().toBuffer();
    serve(original, "image/tiff");
    const { admin, upload } = fixture();
    await expect(fillImageDerivatives(admin, { ...big, original_path: "employee/scan.tif", mime_type: "image/tiff" })).resolves.toEqual({ ok: true });
    const made = await uploaded(upload);
    expect(made["derived/employee/photo_thumb.webp"]).toMatchObject({ width: 640, height: 480 });
    // Smaller than the preview size: kept as is, not blown up.
    expect(made["derived/employee/photo_preview.webp"]).toMatchObject({ width: 1200, height: 900 });
  });

  it("applies the EXIF orientation so a rotated phone photo comes out upright", async () => {
    const original = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#40c040" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    serve(original, "image/jpeg");
    const { admin, upload } = fixture();
    await expect(fillImageDerivatives(admin, big)).resolves.toEqual({ ok: true });
    const made = await uploaded(upload);
    expect(made["derived/employee/photo_thumb.webp"]).toMatchObject({ width: 320, height: 640 });
  });

  it("reports bytes no renderer reads as a deliberate file tile", async () => {
    serve(Buffer.from("not an image at all, and not small either".repeat(64)), "image/x-adobe-dng");
    const { admin, upload, update } = fixture();
    const result = await fillImageDerivatives(admin, { ...big, original_path: "employee/raw.dng", mime_type: "image/x-adobe-dng" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/unsupported image format/);
    expect(upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a HEIC over the transform cap without downloading it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { admin, upload } = fixture();
    await expect(fillImageDerivatives(admin, { ...row, original_bytes: TRANSFORM_MAX_BYTES + 1 }))
      .resolves.toEqual({ ok: false, reason: `image/heic over ${TRANSFORM_MAX_BYTES} bytes` });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps a failed download retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const { admin, update } = fixture();
    await expect(fillImageDerivatives(admin, big)).rejects.toThrow("download original: 503");
    expect(update).not.toHaveBeenCalled();
  });
});
