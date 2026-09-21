import { describe, expect, it } from "vitest";
import * as Q from "./upload-queue";

const f = (name: string, size = 10, lastModified = 1000) =>
  new File([new Uint8Array(size)], name, { lastModified });
const meta = { jobId: "job-1", tags: [] };
let n = 0;
const id = () => `id-${++n}`;
const enq = (q: Q.Queue, paired: Q.PairedFile[]) =>
  Q.enqueue(q, paired, meta, 0, id);

describe("upload-queue", () => {
  it("enqueue → start/progress/complete keeps one item per file", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }, { file: f("b.jpg") }]);
    q = Q.start(q, q.items[0].photoId);
    q = Q.progress(q, q.items[0].photoId, 5);
    q = Q.recordOutcome(q, q.items[0].photoId, { status: "done" });
    expect(q.items.map((i) => i.status)).toEqual(["done", "queued"]);
  });

  it("retry keeps the photoId", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }]);
    const before = q.items[0].photoId;
    q = Q.retry(Q.fail(q, before, "boom"), before);
    expect(q.items[0]).toMatchObject({
      photoId: before,
      status: "queued",
      error: undefined,
    });
  });

  it("manifest strips files, restores as interrupted, expires after 24h", () => {
    const q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }]);
    const saved = Q.toManifest(q, 1);
    expect(Q.restoreManifest(saved, 1).files.size).toBe(0);
    expect(Q.restoreManifest(saved, 1).items[0].status).toBe("interrupted");
    expect(Q.restoreManifest(saved, Q.MANIFEST_TTL_MS + 1).items).toHaveLength(0);
  });

  it("adoptRepick matches name+size+mtime and reports the rest", () => {
    const q = Q.restoreManifest(
      Q.toManifest(enq(Q.emptyQueue(), [{ file: f("a.jpg", 10, 7) }]), 0),
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
      Q.toManifest(
        enq(Q.emptyQueue(), [
          { file: f("a.jpg", 10, 7), sidecar: f("a.xmp", 2, 7) },
        ]),
        0
      ),
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
      Q.toManifest(
        enq(Q.emptyQueue(), [
          { file: f("a.jpg", 10, 7), sidecar: f("a.xmp", 2, 7) },
        ]),
        0
      ),
      0
    );
    const { unmatched } = Q.adoptRepick(q, [f("a.xmp", 2, 7)]);
    expect(unmatched.map((u) => u.name)).toEqual(["a.xmp"]);
  });

  it("retains attempt identity across reload and lets the engine fence changed reselected bytes", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg", 10, 7) }]);
    const key = q.items[0].photoId;
    const identity = { attemptId: "attempt", photoId: "server-photo", contentSha256: "a".repeat(64), sourceSignature: "old-source" };
    q = Q.rememberIdentity(q, key, identity);
    const restored = Q.restoreManifest(Q.toManifest(q, 0), 0);
    const unchanged = Q.adoptRepick(restored, [f("a.jpg", 10, 7)]).queue;
    expect(unchanged.items[0].uploadIdentity).toEqual(identity);
    const changed = Q.adoptRepick(restored, [f("a.jpg", 20, 8)]);
    expect(changed.unmatched).toEqual([]);
    expect(changed.queue.items[0]).toMatchObject({ photoId: key, size: 20, lastModified: 8, uploadIdentity: identity, status: "queued" });
  });

  it.each(["job_conflict", "restore_required", "waiting_claim"] as const)("keeps %s unresolved and recoverable", (status) => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }]);
    const key = q.items[0].photoId;
    q = Q.recordOutcome(q, key, { status, canonicalPhotoId: "canonical", canonicalJobId: "other", error: "Remedy required" });
    expect(Q.isActive(q)).toBe(false);
    expect(Q.clearSettled(q).items).toHaveLength(1);
    const saved = Q.toManifest(q, 0);
    expect(saved[0]).toMatchObject({ canonicalPhotoId: "canonical", canonicalJobId: "other" });
    const restored = Q.restoreManifest(saved, 0);
    expect(Q.retry(restored, key).items[0].status).toBe("interrupted");
  });

  it("keeps original completion warnings visible without retrying the upload", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }]);
    q = Q.recordOutcome(q, q.items[0].photoId, { status: "done", warnings: ["Reselect the XMP sidecar to retry it."] });
    expect(Q.toManifest(q, 0)).toEqual([]);
    expect(q.items[0].warnings).toEqual(["Reselect the XMP sidecar to retry it."]);
  });

  it("recovers sidecar-only retries without asking for the completed original again", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg"), sidecar: f("a.xmp") }]);
    const key = q.items[0].photoId;
    q = Q.recordOutcome(q, key, { status: "done", sidecarRetry: true, warnings: ["Sidecar upload failed."] });
    expect(Q.clearSettled(q).items).toHaveLength(1);
    const restored = Q.restoreManifest(Q.toManifest(q, 0), 0);
    expect(restored.items[0]).toMatchObject({ status: "done", sidecarRetry: true });
    expect(restored.files.size).toBe(0);
    q = Q.recordOutcome(q, key, { status: "retrying_sidecar", sidecarRetry: true });
    expect(Q.isActive(q)).toBe(true);
    expect(Q.restoreManifest(Q.toManifest(q, 0), 0).items[0].status).toBe("done");
    q = Q.recordOutcome(q, key, { status: "done", sidecarRetry: false, warnings: [] });
    expect(Q.clearSettled(q).items).toEqual([]);
    expect(Q.toManifest(q, 0)).toEqual([]);
  });

  it("preserves Retry-After across retry clicks and reload/reselection", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }]);
    const key = q.items[0].photoId;
    q = Q.recordOutcome(q, key, { status: "failed", retryAt: 30_000, error: "Retry later" });
    expect(Q.retry(q, key, 29_999)).toBe(q);
    expect(Q.retry(q, key, 30_000).items[0].status).toBe("queued");
    const restored = Q.restoreManifest(Q.toManifest(q, 0), 0);
    const repicked = Q.adoptRepick(restored, [f("a.jpg")], 29_999).queue;
    expect(repicked.items[0]).toMatchObject({ status: "failed", retryAt: 30_000 });
    expect(Q.nextQueued(repicked)).toBeNull();
    expect(Q.retry(repicked, key, 30_000).items[0]).toMatchObject({ status: "queued", retryAt: undefined });
  });

  it("remove drops the item and its file; clearSettled keeps live work", () => {
    let q = enq(Q.emptyQueue(), [{ file: f("a.jpg") }, { file: f("b.jpg") }]);
    const [a, b] = q.items.map((i) => i.photoId);
    q = Q.remove(q, a);
    expect(q.items.map((i) => i.photoId)).toEqual([b]);
    expect(q.files.has(a)).toBe(false);

    q = Q.recordOutcome(Q.start(q, b), b, { status: "done" });
    q = Q.clearSettled(q);
    expect(q.items).toHaveLength(0);
    expect(q.files.size).toBe(0);
  });
});

// A replayed attempt is compared with the albums it first named, so the queue item — and the
// manifest that survives a reload — must carry them into retry and cancellation.
describe("an album upload keeps its albums", () => {
  const albums = ["11111111-1111-4111-8111-111111111111"];
  const identity = { attemptId: "attempt", photoId: "server-photo", contentSha256: "a".repeat(64), sourceSignature: JSON.stringify(["a.jpg", 10, 7, "image/jpeg"]) };
  it("through enqueue, the manifest, and cancellation, with no project", () => {
    let q = Q.enqueue(Q.emptyQueue(), [{ file: f("a.jpg", 10, 7) }], { jobId: null, albumIds: albums, tags: [] }, 0, () => "local-1");
    expect(q.items[0]).toMatchObject({ jobId: null, albumIds: albums });
    q = Q.rememberIdentity(q, "local-1", identity);
    expect(Q.cancellationInput(q.items[0])).toMatchObject({ job_id: null, album_ids: albums });
    const restored = Q.restoreManifest(Q.toManifest(q, 1), 2);
    expect(restored.items[0]).toMatchObject({ jobId: null, albumIds: albums, status: "interrupted" });
  });
  it("sends an empty list for an item saved before albums existed", () => {
    const q = Q.rememberIdentity(enq(Q.emptyQueue(), [{ file: f("a.jpg", 10, 7) }]), "x", identity);
    const legacy = { ...q.items[0], albumIds: undefined, uploadIdentity: identity };
    expect(Q.cancellationInput(legacy)).toMatchObject({ job_id: "job-1", album_ids: [] });
  });
});

describe("durable ordinary upload removal", () => {
  const identity = { attemptId: "attempt", photoId: "server-photo", contentSha256: "a".repeat(64), sourceSignature: JSON.stringify(["a.jpg", 10, 7, "image/jpeg"]) };
  const pending = () => {
    const q = enq(Q.emptyQueue(), [{ file: f("a.jpg", 10, 7) }]);
    return Q.beginRemoval(Q.rememberIdentity(q, q.items[0].photoId, identity), q.items[0].photoId);
  };
  it("persists unconfirmed removal beyond the normal manifest TTL and cannot resume it", () => {
    const q = pending(); const key = q.items[0].photoId;
    expect(Q.cancellationInput(q.items[0])).toMatchObject({ owner_kind: "ordinary", attempt_id: "attempt", original_name: "a.jpg", original_bytes: 10, mime_type: "image/jpeg" });
    const restored = Q.restoreManifest(Q.toManifest(q, Q.MANIFEST_TTL_MS + 1), Q.MANIFEST_TTL_MS * 2);
    expect(restored.items[0]).toMatchObject({ status: "cancel_pending", uploadIdentity: identity });
    expect(Q.retry(restored, key)).toEqual(restored);
    expect(Q.adoptRepick(restored, [f("a.jpg", 10, 7)]).unmatched).toHaveLength(1);
    expect(Q.recordOutcome(restored, key, { status: "interrupted" })).toEqual(restored);
    expect(Q.clearSettled(restored)).toEqual(restored);
    expect(Q.removalFailed(restored, key, "Offline").items[0].error).toContain("Retry removal");
    expect(Q.finishRemoval(restored, key, { status: "cancelled" }).items).toEqual([]);
  });
  it("keeps a finalize winner and its XMP reselection warning", () => {
    const q = pending(); const key = q.items[0].photoId;
    const settled = Q.finishRemoval(q, key, { status: "created", photo_id: "committed", job_id: meta.jobId,
      warnings: ["Reselect XMP"], sidecar_retry: true });
    expect(settled.items[0]).toMatchObject({ status: "done", canonicalPhotoId: "committed", sidecarRetry: true, warnings: ["Reselect XMP"] });
    expect(Q.clearSettled(settled).items).toHaveLength(1);
  });
});
