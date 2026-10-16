// Pure state for the app-level upload queue. The manager (upload-manager.tsx)
// dispatches these transitions; nothing here touches React, storage, or the
// network.

import { classifyFile } from "./classify";
import type { BatchMeta, UploadIdentity, UploadStage } from "./upload";
import type { CancelUploadInput, CancelUploadOutcome, FormatTwin } from "./upload-contract";

export type QueueStatus =
  | "queued"
  | "uploading"
  | "done"
  | "failed"
  | "duplicate"
  | "job_conflict"
  | "restore_required"
  | "waiting_claim"
  /** Held, not uploaded: the project already has this shot in another format. */
  | "format_twin"
  | "retrying_sidecar"
  | "cancelling"
  | "cancel_pending"
  | "interrupted";

/** An uploading row's step; "reconnecting" while the batch waits out a dropped connection. */
export type QueueStage = UploadStage | "reconnecting";

export interface QueueItem {
  photoId: string;
  /** The project, or null when the upload names only albums. */
  jobId: string | null;
  /** Albums the photo joins. Persisted: a retry must replay the same list. */
  albumIds?: string[];
  tags: string[];
  name: string;
  size: number;
  type: string;
  lastModified: number;
  enqueuedAt: number;
  status: QueueStatus;
  sentBytes: number;
  /** While uploading: what the file is doing. Never persisted. */
  stage?: QueueStage;
  error?: string;
  canonicalPhotoId?: string;
  /** Null when the existing photo has no project. */
  canonicalJobId?: string | null;
  warnings?: string[];
  /** Server attempt identity is independent of the local queue item's key. */
  uploadIdentity?: UploadIdentity;
  sidecarRetry?: boolean;
  retryAt?: number;
  /** Shutter time for in-app camera shots (ISO). */
  shutterAt?: string;
  /** Paired .xmp filename (the sidecar File rides in Queue.files). */
  sidecarName?: string;
  /** With status format_twin: the photo this file looks like another format of. */
  twin?: FormatTwin;
  /** The uploader pressed Keep: upload even though it looks like a format twin. */
  keepFormatTwin?: boolean;
}

/** An uploadable file with its .xmp, if one was paired to it at pick time. */
export interface PairedFile {
  file: File;
  sidecar?: File;
}

/** Files live only in memory; the manifest never carries them. */
export interface Queue {
  items: QueueItem[];
  files: Map<string, PairedFile>;
}

export type Persisted = Omit<QueueItem, "status" | "sentBytes" | "stage"> & {
  status: "interrupted" | "done" | "cancel_pending";
};

export const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

export const emptyQueue = (): Queue => ({ items: [], files: new Map() });

/**
 * Add a picked batch, already paired by the caller: a .xmp never becomes its
 * own item — it rides on its image's entry (and manifest as sidecarName).
 */
export function enqueue(
  q: Queue,
  paired: PairedFile[],
  meta: BatchMeta,
  now: number,
  newId: () => string = () => crypto.randomUUID()
): Queue {
  const items = [...q.items];
  const map = new Map(q.files);
  for (const { file, sidecar } of paired) {
    const photoId = newId();
    items.push({
      photoId,
      jobId: meta.jobId,
      albumIds: meta.albumIds ?? [],
      tags: meta.tags ?? [],
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      enqueuedAt: now,
      status: "queued",
      sentBytes: 0,
      shutterAt: meta.shutterAt?.get(file)?.toISOString(),
      sidecarName: sidecar?.name,
    });
    map.set(photoId, { file, sidecar });
  }
  return { items, files: map };
}

const patch = (q: Queue, photoId: string, p: Partial<QueueItem>): Queue => ({
  ...q,
  items: q.items.map((i) => (i.photoId === photoId ? { ...i, ...p } : i)),
});

export const start = (q: Queue, id: string) =>
  patch(q, id, { status: "uploading", stage: "preparing", sentBytes: 0, error: undefined, retryAt: undefined });
/** Only an uploading row has a stage; a late report for a settled row changes nothing. A new try starts its bytes from zero. */
export const setStage = (q: Queue, id: string, stage: QueueStage) =>
  q.items.find((item) => item.photoId === id)?.status !== "uploading" ? q
    : patch(q, id, stage === "preparing" ? { stage, sentBytes: 0 } : { stage });
export const progress = (q: Queue, id: string, sentBytes: number) =>
  patch(q, id, { sentBytes });
/** Keep only the warnings `keep` passes (the server made a row's previews, so its note is gone). */
export const keepWarnings = (q: Queue, id: string, keep: (warning: string) => boolean) => {
  const item = q.items.find((candidate) => candidate.photoId === id);
  return !item?.warnings?.some((warning) => !keep(warning)) ? q : patch(q, id, { warnings: item.warnings.filter(keep) });
};
export const fail = (q: Queue, id: string, error: string) =>
  patch(q, id, { status: "failed", error });
export const recordOutcome = (
  q: Queue, id: string,
  outcome: Pick<QueueItem, "status"> & Partial<Pick<QueueItem,
    "error" | "canonicalPhotoId" | "canonicalJobId" | "warnings" | "sidecarRetry" | "retryAt" | "twin">>,
) => isRemoving(q.items.find((item) => item.photoId === id)) ? q : patch(q, id, { retryAt: undefined, ...outcome });
/** Keep a held format twin: queue it again, this time to upload. */
export const keep = (q: Queue, id: string) =>
  q.items.find((item) => item.photoId === id)?.status !== "format_twin" ? q :
    patch(q, id, { status: q.files.has(id) ? "queued" : "interrupted", keepFormatTwin: true, twin: undefined, error: undefined });
export const rememberIdentity = (q: Queue, id: string, uploadIdentity: UploadIdentity) =>
  patch(q, id, { uploadIdentity });
/** Retry keeps the photoId so TUS resumes and finalize stays idempotent. */
export const retry = (q: Queue, id: string, now = Date.now()) =>
  isRemoving(q.items.find((item) => item.photoId === id)) || (q.items.find((item) => item.photoId === id)?.retryAt ?? 0) > now ? q :
    patch(q, id, { status: q.files.has(id) ? "queued" : "interrupted", error: undefined, retryAt: undefined });

/** Every failed row that may be retried now, in one tap. Rows that need a decision first (a move, a restore, a format twin) are left alone. */
export const retryAll = (q: Queue, now = Date.now()) =>
  q.items.filter((item) => item.status === "failed" || item.status === "waiting_claim")
    .reduce((queue, item) => retry(queue, item.photoId, now), q);
/** Rows Retry all would retry now. */
export const retryableNow = (q: Pick<Queue, "items">, now = Date.now()) =>
  q.items.filter((item) => (item.status === "failed" || item.status === "waiting_claim") && (item.retryAt ?? 0) <= now).length;

/** First wait after a dropped connection, doubling to the cap: 5 s, 10 s, 20 s, 40 s, then every minute. */
export const RECONNECT_FIRST_DELAY_MS = 5_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
/** After this long without a connection the file fails as before and the batch moves on. */
export const RECONNECT_GIVE_UP_MS = 30 * 60_000;
export const reconnectDelay = (attempt: number) =>
  Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_FIRST_DELAY_MS * 2 ** Math.max(0, attempt - 1));

/**
 * Byte progress arrives on every network event, tens a second on a big file,
 * and each one re-rendered the tray. Let a tick through only when the whole
 * percent moved and at least `minIntervalMs` passed, plus the first and the
 * last, so a row updates about four times a second at most.
 */
export function createProgressGate(minIntervalMs = 250, now: () => number = Date.now) {
  const last = new Map<string, { percent: number; at: number }>();
  return (id: string, sent: number, total: number): boolean => {
    if (sent >= total) {
      last.delete(id);
      return true;
    }
    const percent = total > 0 ? Math.floor((sent / total) * 100) : 0;
    const previous = last.get(id);
    const time = now();
    if (previous && (percent === previous.percent || time - previous.at < minIntervalMs)) return false;
    last.set(id, { percent, at: time });
    return true;
  };
}

export const isRemoving = (item?: Pick<QueueItem, "status">) => item?.status === "cancelling" || item?.status === "cancel_pending";
export const beginRemoval = (q: Queue, id: string) => patch(q, id, {
  status: "cancelling", error: undefined, retryAt: undefined,
});
export const removalFailed = (q: Queue, id: string, error: string) => patch(q, id, {
  status: "cancel_pending", error: `Removal pending — ${error} Retry removal to finish.`,
});
export function finishRemoval(q: Queue, id: string, result: CancelUploadOutcome): Queue {
  // A finalize that committed first wins. Keep its sidecar warning/reselection
  // state visible; cancelling an attempt never removes the committed photo.
  if (result.status === "created") return patch(q, id, {
    status: "done", canonicalPhotoId: result.photo_id, canonicalJobId: result.job_id,
    warnings: result.warnings ?? [], sidecarRetry: result.sidecar_retry ?? false,
    error: undefined, retryAt: undefined,
  });
  return remove(q, id);
}

export function cancellationInput(item: QueueItem): CancelUploadInput | null {
  const identity = item.uploadIdentity;
  if (!identity) return null;
  const source: unknown = JSON.parse(identity.sourceSignature);
  if (!Array.isArray(source) || source.length !== 4 || typeof source[0] !== "string" ||
      typeof source[1] !== "number" || typeof source[3] !== "string") {
    throw new Error("Upload identity is unavailable.");
  }
  return { owner_kind: "ordinary", attempt_id: identity.attemptId, photo_id: identity.photoId,
    job_id: item.jobId, album_ids: item.albumIds ?? [],
    source_signature: identity.sourceSignature, content_sha256: identity.contentSha256,
    original_name: source[0], original_bytes: source[1], mime_type: source[3] };
}

export function remove(q: Queue, photoId: string): Queue {
  const files = new Map(q.files);
  files.delete(photoId);
  return { items: q.items.filter((i) => i.photoId !== photoId), files };
}

/** Drop landed rows (done/duplicate) and release their in-memory Files. */
export function clearSettled(q: Queue): Queue {
  const items = q.items.filter(
    (i) => (i.status !== "done" || i.sidecarRetry) && i.status !== "duplicate"
  );
  const live = new Set(items.map((i) => i.photoId));
  const files = new Map([...q.files].filter(([id]) => live.has(id)));
  return { items, files };
}

export const nextQueued = (q: Queue) =>
  q.items.find((i) => i.status === "queued") ?? null;
export const isActive = (q: Queue) =>
  q.items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "retrying_sidecar" || i.status === "cancelling");

/**
 * Persist everything still recoverable — including `failed`, so a failure
 * survives navigation as a re-pickable entry instead of silently reading as a
 * successful upload. `done`/`duplicate` are left out: nothing to recover.
 */
export function toManifest(q: Queue, now: number): Persisted[] {
  return q.items
    .filter(
      (i) =>
        isRemoving(i) || ((i.status === "queued" ||
          i.status === "uploading" ||
          i.status === "failed" ||
          i.status === "job_conflict" ||
          i.status === "restore_required" ||
          i.status === "waiting_claim" ||
          i.status === "format_twin" ||
          i.status === "retrying_sidecar" ||
          (i.status === "done" && i.sidecarRetry) ||
          i.status === "interrupted") &&
        now - i.enqueuedAt < MANIFEST_TTL_MS)
    )
    .map(({ sentBytes, stage, ...i }) => ({ ...i,
      status: isRemoving(i) ? "cancel_pending" as const : i.sidecarRetry && (i.status === "done" || i.status === "retrying_sidecar") ? "done" as const : "interrupted" as const,
    }));
}

export function restoreManifest(saved: Persisted[], now: number): Queue {
  return {
    items: saved
      .filter((i) => i.status === "cancel_pending" || now - i.enqueuedAt < MANIFEST_TTL_MS)
      .map((i) => ({ ...i,
        status: i.status === "cancel_pending" ? "cancel_pending" as const : i.status === "done" && i.sidecarRetry ? "done" as const : "interrupted" as const,
        sentBytes: 0,
      })),
    files: new Map(),
  };
}

/**
 * Exact name+size+mtime matches retain their attempt identity. A uniquely
 * named changed file is reselected with fresh source metadata; hashing will
 * create a fresh attempt. A re-picked .xmp re-attaches to its recorded entry.
 * sidecarName (primaries adopt first, so picking the pair together works).
 */
export function adoptRepick(
  q: Queue,
  files: File[],
  now = Date.now(),
): { queue: Queue; unmatched: File[] } {
  const map = new Map(q.files);
  let items = q.items;
  const unmatched: File[] = [];
  const sidecars: File[] = [];
  for (const file of files) {
    if (classifyFile(file).kind === "sidecar") {
      sidecars.push(file);
      continue;
    }
    const exact = items.find(
      (i) =>
        i.status === "interrupted" &&
        i.name === file.name &&
        i.size === file.size &&
        i.lastModified === file.lastModified
    );
    let hit = exact;
    if (!hit) {
      const named = items.filter((i) => i.status === "interrupted" && i.name === file.name);
      if (named.length === 1) hit = named[0];
    }
    if (!hit) {
      unmatched.push(file);
      continue;
    }
    map.set(hit.photoId, { file });
    items = items.map((i) => (i === hit ? {
      ...i, status: (i.retryAt ?? 0) > now ? "failed" as const : "queued" as const,
      size: file.size, type: file.type, lastModified: file.lastModified,
    } : i));
  }
  for (const file of sidecars) {
    const owner = items.find(
      (i) =>
        (i.status === "queued" || i.status === "interrupted" || (i.status === "failed" && (i.retryAt ?? 0) > now)) &&
        i.sidecarName === file.name &&
        map.has(i.photoId)
    );
    const entry = owner ? map.get(owner.photoId) : undefined;
    if (!owner || !entry) {
      unmatched.push(file);
      continue;
    }
    map.set(owner.photoId, { ...entry, sidecar: file });
  }
  return { queue: { items, files: map }, unmatched };
}
