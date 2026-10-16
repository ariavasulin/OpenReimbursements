import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ACTION_RUN_PHOTOS, PartialBulkError } from "./chunks";
import { runPhotoAction } from "./trash-now";

const ids = Array.from({ length: 2500 }, (_, index) => `p${index}`);

/** A fake POST /api/photos/bulk: reaches every id but the first of each slice, which it leaves out. */
function fakeBulk(failOnCall?: number) {
  let calls = 0;
  return vi.fn(async (_url: string, init: RequestInit) => {
    calls += 1;
    if (calls === failOnCall) return Response.json({ error: { message: "Photo operations are temporarily unavailable." } }, { status: 503 });
    const { photo_ids } = JSON.parse(String(init.body)) as { photo_ids: string[] };
    return Response.json({ batch_id: `b${calls}`, photo_ids: photo_ids.slice(1), left_out: 1, failed: 0 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("runPhotoAction", () => {
  it("sends one request per slice of MAX_ACTION_RUN_PHOTOS, adds the answers up, and reports progress", async () => {
    const fetch = fakeBulk();
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const result = await runPhotoAction("trash", ids, progress);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("/api/photos/bulk"));
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map((body) => [body.action, body.photo_ids.length])).toEqual([
      ["trash", MAX_ACTION_RUN_PHOTOS], ["trash", MAX_ACTION_RUN_PHOTOS], ["trash", 500],
    ]);
    expect(result.photoIds).toHaveLength(2500 - 3);
    expect(result).toMatchObject({ leftOut: 3, failed: 0 });
    expect(progress.mock.calls).toEqual([[1000, 2500], [2000, 2500], [2500, 2500]]);
  });

  it("says how far it got when a later slice fails", async () => {
    vi.stubGlobal("fetch", fakeBulk(2));
    const failure = await runPhotoAction("restore", ids).catch((reason) => reason);
    expect(failure).toBeInstanceOf(PartialBulkError);
    expect(failure).toMatchObject({ done: 1000, total: 2500, message: "Photo operations are temporarily unavailable." });
  });
});
