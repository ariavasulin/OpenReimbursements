import { describe, expect, it, vi } from "vitest";
import { inChunks, PartialBulkError, sumCounts } from "./chunks";

const ids = Array.from({ length: 1200 }, (_, index) => `p${index}`);

describe("inChunks", () => {
  it("sends 1,200 ids as 500 + 500 + 200, in order, reporting progress", async () => {
    const sizes: number[] = [];
    const progress = vi.fn();
    const results = await inChunks(ids, async (chunk) => { sizes.push(chunk.length); return chunk[0]; }, progress);
    expect(sizes).toEqual([500, 500, 200]);
    expect(results).toEqual(["p0", "p500", "p1000"]);
    expect(progress.mock.calls).toEqual([[500, 1200], [1000, 1200], [1200, 1200]]);
  });

  it("rethrows a first-slice failure as is, and a later one with what was done", async () => {
    const boom = new Error("Too many");
    await expect(inChunks(ids, async () => { throw boom; })).rejects.toBe(boom);
    let calls = 0;
    const failure = await inChunks(ids, async () => { if (++calls === 3) throw boom; }).catch((reason) => reason);
    expect(failure).toBeInstanceOf(PartialBulkError);
    expect(failure).toMatchObject({ done: 1000, total: 1200, message: "Too many" });
  });
});

describe("sumCounts", () => {
  it("adds each count across slices", () => {
    expect(sumCounts([{ updated: 500, skipped: 0 }, { updated: 198, skipped: 2 }], ["updated", "skipped"])).toEqual({ updated: 698, skipped: 2 });
  });
});
