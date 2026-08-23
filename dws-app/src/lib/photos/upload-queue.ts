// Pure state for the app-level upload queue. The manager (upload-manager.tsx)
// dispatches these transitions; nothing here touches React, storage, or the
// network, so every rule (retry keeps the photoId, manifests expire, re-picks
// match by identity) is unit-testable.

import type { BatchMeta } from "./upload";

export type QueueStatus =
  | "queued"
  | "uploading"
  | "done"
  | "failed"
  | "duplicate"
  | "interrupted";

export interface QueueItem {
  photoId: string;
  jobId: string;
  sheetNumber: string | null;
  tags: string[];
  name: string;
  size: number;
  type: string;
  lastModified: number;
  enqueuedAt: number;
  status: QueueStatus;
  sentBytes: number;
  error?: string;
  /** Shutter time for in-app camera shots (ISO). */
  shutterAt?: string;
  /** Phase 3: paired .xmp filename. */
  sidecarName?: string;
}

/** Files live only in memory; the manifest never carries them. */
export interface Queue {
  items: QueueItem[];
  files: Map<string, { file: File; sidecar?: File }>;
}

export type Persisted = Omit<QueueItem, "status"> & { status: "interrupted" };

export const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

export const emptyQueue = (): Queue => ({ items: [], files: new Map() });

export function enqueue(
  q: Queue,
  files: File[],
  meta: BatchMeta,
  now: number,
  newId: () => string = () => crypto.randomUUID()
): Queue {
  const items = [...q.items];
  const map = new Map(q.files);
  for (const file of files) {
    const photoId = newId();
    items.push({
      photoId,
      jobId: meta.jobId,
      sheetNumber: meta.sheetNumber ?? null,
      tags: meta.tags ?? [],
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      enqueuedAt: now,
      status: "queued",
      sentBytes: 0,
      shutterAt: meta.shutterAt?.get(file)?.toISOString(),
    });
    map.set(photoId, { file });
  }
  return { items, files: map };
}

const patch = (q: Queue, photoId: string, p: Partial<QueueItem>): Queue => ({
  ...q,
  items: q.items.map((i) => (i.photoId === photoId ? { ...i, ...p } : i)),
});

export const start = (q: Queue, id: string) =>
  patch(q, id, { status: "uploading", sentBytes: 0, error: undefined });
export const progress = (q: Queue, id: string, sentBytes: number) =>
  patch(q, id, { sentBytes });
export const complete = (q: Queue, id: string) => patch(q, id, { status: "done" });
export const fail = (q: Queue, id: string, error: string) =>
  patch(q, id, { status: "failed", error });
export const markDuplicate = (q: Queue, id: string) =>
  patch(q, id, { status: "duplicate" });
/** Retry keeps the photoId so TUS resumes and finalize stays idempotent. */
export const retry = (q: Queue, id: string) =>
  patch(q, id, { status: "queued", error: undefined });

export function remove(q: Queue, photoId: string): Queue {
  const files = new Map(q.files);
  files.delete(photoId);
  return { items: q.items.filter((i) => i.photoId !== photoId), files };
}

/** Drop landed rows (done/duplicate) and release their in-memory Files. */
export function clearSettled(q: Queue): Queue {
  const items = q.items.filter(
    (i) => i.status !== "done" && i.status !== "duplicate"
  );
  const files = new Map(q.files);
  for (const [id] of q.files) {
    if (!items.some((i) => i.photoId === id)) files.delete(id);
  }
  return { items, files };
}

export const nextQueued = (q: Queue) =>
  q.items.find((i) => i.status === "queued") ?? null;
export const isActive = (q: Queue) =>
  q.items.some((i) => i.status === "queued" || i.status === "uploading");

export function toManifest(q: Queue, now: number): Persisted[] {
  return q.items
    .filter(
      (i) =>
        (i.status === "queued" ||
          i.status === "uploading" ||
          i.status === "interrupted") &&
        now - i.enqueuedAt < MANIFEST_TTL_MS
    )
    .map((i) => ({ ...i, status: "interrupted" as const }));
}

export function restoreManifest(saved: Persisted[], now: number): Queue {
  return {
    items: saved
      .filter((i) => now - i.enqueuedAt < MANIFEST_TTL_MS)
      .map((i) => ({ ...i, status: "interrupted" as const, sentBytes: 0 })),
    files: new Map(),
  };
}

/** Re-picked files that match an interrupted entry (name+size+mtime) become queued again. */
export function adoptRepick(
  q: Queue,
  files: File[]
): { queue: Queue; unmatched: File[] } {
  const map = new Map(q.files);
  let items = q.items;
  const unmatched: File[] = [];
  for (const file of files) {
    const hit = items.find(
      (i) =>
        i.status === "interrupted" &&
        i.name === file.name &&
        i.size === file.size &&
        i.lastModified === file.lastModified
    );
    if (!hit) {
      unmatched.push(file);
      continue;
    }
    map.set(hit.photoId, { file });
    items = items.map((i) => (i === hit ? { ...i, status: "queued" as const } : i));
  }
  return { queue: { items, files: map }, unmatched };
}
