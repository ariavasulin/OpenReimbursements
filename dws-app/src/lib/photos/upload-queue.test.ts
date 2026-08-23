import { describe, expect, it } from "vitest";
import * as Q from "./upload-queue";

const f = (name: string, size = 10, lastModified = 1000) =>
  new File([new Uint8Array(size)], name, { lastModified });
const meta = { jobId: "job-1", sheetNumber: null, tags: [] };
let n = 0;
const id = () => `id-${++n}`;
const enq = (q: Q.Queue, files: File[]) => Q.enqueue(q, files, meta, 0, id).queue;

describe("upload-queue", () => {
  it("enqueue → start/progress/complete keeps one item per file", () => {
    let q = enq(Q.emptyQueue(), [f("a.jpg"), f("b.jpg")]);
    q = Q.start(q, q.items[0].photoId);
    q = Q.progress(q, q.items[0].photoId, 5);
    q = Q.complete(q, q.items[0].photoId);
    expect(q.items.map((i) => i.status)).toEqual(["done", "queued"]);
  });

  it("retry keeps the photoId", () => {
    let q = enq(Q.emptyQueue(), [f("a.jpg")]);
    const before = q.items[0].photoId;
    q = Q.retry(Q.fail(q, before, "boom"), before);
    expect(q.items[0]).toMatchObject({
      photoId: before,
      status: "queued",
      error: undefined,
    });
  });

  it("enqueue pairs a .xmp onto its image instead of making an item", () => {
    const { queue, rejected } = Q.enqueue(
      Q.emptyQueue(),
      [f("IMG_1.JPG"), f("img_1.xmp")],
      meta,
      0,
      id
    );
    expect(rejected).toEqual([]);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      name: "IMG_1.JPG",
      sidecarName: "img_1.xmp",
    });
    expect(queue.files.get(queue.items[0].photoId)?.sidecar?.name).toBe(
      "img_1.xmp"
    );
  });

  it("enqueue rejects a lone .xmp — no item, surfaced to the caller", () => {
    const { queue, rejected } = Q.enqueue(
      Q.emptyQueue(),
      [f("lonely.xmp")],
      meta,
      0,
      id
    );
    expect(queue.items).toEqual([]);
    expect(rejected.map((r) => r.name)).toEqual(["lonely.xmp"]);
  });

  it("manifest strips files, restores as interrupted, expires after 24h", () => {
    const q = enq(Q.emptyQueue(), [f("a.jpg")]);
    const saved = Q.toManifest(q, 1);
    expect(JSON.stringify(saved)).not.toContain("File");
    expect(Q.restoreManifest(saved, 1).items[0].status).toBe("interrupted");
    expect(Q.restoreManifest(saved, Q.MANIFEST_TTL_MS + 1).items).toHaveLength(0);
  });

  it("adoptRepick matches name+size+mtime and reports the rest", () => {
    const q = Q.restoreManifest(
      Q.toManifest(enq(Q.emptyQueue(), [f("a.jpg", 10, 7)]), 0),
      0
    );
    const { queue, unmatched } = Q.adoptRepick(q, [
      f("a.jpg", 10, 7),
      f("a.jpg", 11, 7),
    ]);
    expect(queue.items[0].status).toBe("queued");
    expect(queue.files.size).toBe(1);
    expect(unmatched.map((u) => u.size)).toEqual([11]);
  });

  it("adoptRepick re-attaches a re-picked sidecar to its entry", () => {
    const q = Q.restoreManifest(
      Q.toManifest(enq(Q.emptyQueue(), [f("a.jpg", 10, 7), f("a.xmp", 2, 7)]), 0),
      0
    );
    const { queue, unmatched } = Q.adoptRepick(q, [
      f("a.jpg", 10, 7),
      f("a.xmp", 2, 7),
    ]);
    expect(unmatched).toEqual([]);
    expect(queue.items[0].status).toBe("queued");
    expect(queue.files.get(queue.items[0].photoId)?.sidecar?.name).toBe("a.xmp");
  });

  it("adoptRepick reports a sidecar whose primary was never re-picked", () => {
    const q = Q.restoreManifest(
      Q.toManifest(enq(Q.emptyQueue(), [f("a.jpg", 10, 7), f("a.xmp", 2, 7)]), 0),
      0
    );
    const { unmatched } = Q.adoptRepick(q, [f("a.xmp", 2, 7)]);
    expect(unmatched.map((u) => u.name)).toEqual(["a.xmp"]);
  });

  it("remove drops the item and its file; clearSettled keeps live work", () => {
    let q = enq(Q.emptyQueue(), [f("a.jpg"), f("b.jpg")]);
    const [a, b] = q.items.map((i) => i.photoId);
    q = Q.remove(q, a);
    expect(q.items.map((i) => i.photoId)).toEqual([b]);
    expect(q.files.has(a)).toBe(false);

    q = Q.complete(Q.start(q, b), b);
    q = Q.clearSettled(q);
    expect(q.items).toHaveLength(0);
    expect(q.files.size).toBe(0);
  });
});
