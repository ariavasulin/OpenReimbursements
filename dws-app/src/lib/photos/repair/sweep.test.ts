import { describe, expect, it } from "vitest";
import {
  ORPHAN_MS,
  SETTLE_MS,
  TRANSFORM_MAX_BYTES,
  planSweep,
  type RepairRow,
  type StoredObject,
} from "./sweep";

/** A settled (older than SETTLE_MS) image row missing its derivatives. */
const row = (over: Partial<RepairRow> = {}): RepairRow => ({
  id: "p1",
  uploader_id: "u1",
  kind: "image",
  mime_type: "image/jpeg",
  original_path: "originals/u1/p1/a.jpg",
  original_bytes: 1000,
  thumb_path: null,
  created_at: new Date(0).toISOString(),
  ...over,
});

const NOW = SETTLE_MS * 10;
/** Objects the walk found, each owned by some row — never orphan candidates. */
const stored = (...names: string[]): StoredObject[] =>
  names.map((name) => ({
    name,
    created_at: new Date(0).toISOString(),
    has_row: true,
  }));

describe("planSweep", () => {
  it("fills derivatives for a transformable image without a thumb", () => {
    const plan = planSweep([row()], stored("originals/u1/p1/a.jpg"), NOW);
    expect(plan).toEqual([{ action: "fillImageDerivatives", photoId: "p1" }]);
  });

  it("file-tiles a RAW and an oversize image instead of transforming", () => {
    const raw = row({ mime_type: "image/x-adobe-dng" });
    const big = row({
      id: "p2",
      original_path: "originals/u1/p2/b.jpg",
      original_bytes: TRANSFORM_MAX_BYTES + 1,
    });
    const plan = planSweep(
      [raw, big],
      stored("originals/u1/p1/a.jpg", "originals/u1/p2/b.jpg"),
      NOW
    );
    expect(plan).toEqual([
      { action: "markFileTile", photoId: "p1", reason: "not transformable" },
      { action: "markFileTile", photoId: "p2", reason: "not transformable" },
    ]);
  });

  it("plans a poster for a video without a thumb", () => {
    const video = row({ kind: "video", mime_type: "video/quicktime" });
    const plan = planSweep([video], stored(video.original_path), NOW);
    expect(plan).toEqual([{ action: "makeVideoPoster", photoId: "p1" }]);
  });

  it("leaves rows younger than the settle window alone", () => {
    const fresh = row({ created_at: new Date(NOW - SETTLE_MS + 1).toISOString() });
    expect(planSweep([fresh], stored(fresh.original_path), NOW)).toEqual([]);
  });

  it("deletes a row whose original object is missing", () => {
    expect(planSweep([row()], [], NOW)).toEqual([
      { action: "deleteDeadRow", photoId: "p1" },
    ]);
  });

  it("deletes row-less objects only after the orphan window", () => {
    const old: StoredObject = {
      name: "originals/u1/dead/a.jpg",
      created_at: new Date(NOW - ORPHAN_MS - 1).toISOString(),
      has_row: false,
    };
    const young: StoredObject = { ...old, name: "originals/u1/new/b.jpg", created_at: new Date(NOW - 1).toISOString() };
    const owned: StoredObject = { ...old, name: "originals/u1/p9/c.jpg", has_row: true };
    expect(planSweep([], [old, young, owned], NOW)).toEqual([
      { action: "deleteOrphanObject", path: "originals/u1/dead/a.jpg" },
    ]);
  });

  it("orphanMs override (the ?olderThan=0 drill) sweeps young orphans", () => {
    const young: StoredObject = {
      name: "originals/u1/new/b.jpg",
      created_at: new Date(NOW - 1).toISOString(),
      has_row: false,
    };
    expect(planSweep([], [young], NOW, { orphanMs: 0 })).toEqual([
      { action: "deleteOrphanObject", path: "originals/u1/new/b.jpg" },
    ]);
  });

  it("is idempotent: repaired rows and owned objects plan nothing", () => {
    const done = row({ thumb_path: "derived/u1/p1_thumb.webp" });
    const object: StoredObject = {
      name: done.original_path,
      created_at: new Date(0).toISOString(),
      has_row: true,
    };
    expect(planSweep([done], [object], NOW)).toEqual([]);
  });

  it("plans transcodes only when the gate is on and no skip reason is set", () => {
    const pending = row({ kind: "video", thumb_path: "derived/u1/p1_thumb.webp", playback_path: null });
    const skipped = row({
      id: "p2",
      kind: "video",
      original_path: "originals/u1/p2/b.mov",
      thumb_path: "derived/u1/p2_thumb.webp",
      playback_path: null,
      playback_skipped_reason: "over cap",
    });
    const objs = stored(pending.original_path, skipped.original_path);
    expect(planSweep([pending, skipped], objs, NOW)).toEqual([]);
    expect(planSweep([pending, skipped], objs, NOW, { transcode: true })).toEqual([
      { action: "transcodeVideo", photoId: "p1" },
    ]);
  });
});
