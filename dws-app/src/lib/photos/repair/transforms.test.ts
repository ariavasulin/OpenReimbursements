import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineExceeded, WorkBudget } from "./deadline";
import { fillImageDerivatives } from "./transforms";

const row = { id: "photo", uploader_id: "employee", original_path: "employee/original.heic" };

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

  it("uploads both completed renders before updating the active row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("webp", { headers: { "content-type": "image/webp" } })));
    const { admin, upload, update } = fixture();
    await expect(fillImageDerivatives(admin, row)).resolves.toEqual({ ok: true });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledOnce();
  });
});
