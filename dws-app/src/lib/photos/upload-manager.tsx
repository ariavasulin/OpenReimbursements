"use client";

// App-level upload manager: owns the queue (upload-queue.ts) and runs it one
// file at a time, so uploads keep going while the user navigates between
// photos pages. The queue's metadata persists to localStorage as a manifest;
// after a reload the entries come back as "interrupted" and the user re-picks
// the files to resume (browsers can't hold File handles across reloads).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabaseClient";
import { invalidatePhotoCaches } from "./api";
import * as Q from "./upload-queue";
import {
  uploadOne,
  retrySidecar as uploadSidecar,
  type BatchMeta,
  type UploadIdentity,
  type UploadResult,
} from "./upload";
import { plural } from "./format";
import { buildBrowserUploadDeps, cancelBrowserUpload } from "./upload-browser";
import type { CancelUploadOutcome } from "./upload-contract";

const MANIFEST_KEY = "photos.upload-manifest";

type Action =
  | { type: "enqueue"; files: Q.PairedFile[]; meta: BatchMeta; now: number }
  | { type: "start" | "retry" | "remove"; photoId: string }
  | { type: "progress"; photoId: string; sentBytes: number }
  | { type: "fail"; photoId: string; error: string }
  | { type: "beginRemoval"; photoId: string }
  | { type: "removalFailed"; photoId: string; error: string }
  | { type: "finishRemoval"; photoId: string; result: CancelUploadOutcome }
  | { type: "identity"; photoId: string; identity: UploadIdentity }
  | { type: "outcome"; photoId: string; result: UploadResult }
  | { type: "startSidecar"; photoId: string }
  | { type: "restore"; saved: Q.Persisted[]; now: number }
  | { type: "repick"; files: File[] }
  | { type: "dismissDone" };

function reducer(q: Q.Queue, a: Action): Q.Queue {
  switch (a.type) {
    case "enqueue":
      return Q.enqueue(q, a.files, a.meta, a.now);
    case "start":
      return Q.start(q, a.photoId);
    case "progress":
      return Q.progress(q, a.photoId, a.sentBytes);
    case "fail":
      return Q.fail(q, a.photoId, a.error);
    case "identity":
      return Q.rememberIdentity(q, a.photoId, a.identity);
    case "startSidecar":
      return Q.recordOutcome(q, a.photoId, { status: "retrying_sidecar", sidecarRetry: true, error: undefined });
    case "outcome":
      return Q.recordOutcome(q, a.photoId, {
        ...a.result,
        status: a.result.status === "cancelled" ? "interrupted" : a.result.status,
      });
    case "retry":
      return Q.retry(q, a.photoId);
    case "remove":
      return Q.remove(q, a.photoId);
    case "beginRemoval":
      return Q.beginRemoval(q, a.photoId);
    case "removalFailed":
      return Q.removalFailed(q, a.photoId, a.error);
    case "finishRemoval":
      return Q.finishRemoval(q, a.photoId, a.result);
    case "restore":
      return Q.restoreManifest(a.saved, a.now);
    case "repick":
      return Q.adoptRepick(q, a.files).queue;
    case "dismissDone":
      return Q.clearSettled(q);
  }
}

interface Manager {
  items: Q.QueueItem[];
  active: boolean;
  enqueue(files: Q.PairedFile[], meta: BatchMeta): void;
  retry(photoId: string): void;
  retrySidecar(photoId: string, sidecar: File): void;
  remove(photoId: string): void;
  /** Adopts re-picked files into interrupted entries; returns the files that
   * matched nothing (so the tray can name them in a toast). */
  repick(files: File[]): File[];
  dismissDone(): void;
}

const Ctx = createContext<Manager | null>(null);

export const useUploadManager = () => {
  const m = useContext(Ctx);
  if (!m) throw new Error("useUploadManager outside UploadManagerProvider");
  return m;
};

export function UploadManagerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [queue, dispatch] = useReducer(reducer, undefined, Q.emptyQueue);
  const queryClient = useQueryClient();
  const running = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const persistedKey = useRef<string | null>(null);
  // Teardown flag for the runner loop. It lives in a mount-scoped effect
  // rather than the runner effect's own cleanup because that effect re-runs on
  // every queue change — its cleanup would fire on ordinary dispatches, not
  // just unmount.
  const unmounted = useRef(false);
  const inFlight = useRef<{ photoId: string; controller: AbortController } | null>(null);
  const sidecarUploads = useRef(new Map<string, AbortController>());
  const removals = useRef(new Set<string>());
  const removedTransfers = useRef(new Set<string>());
  // Async callbacks must see a Remove/identity transition before React renders.
  const dispatchCurrent = useCallback((action: Action) => {
    queueRef.current = reducer(queueRef.current, action);
    dispatch(action);
  }, []);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      inFlight.current?.controller.abort();
      sidecarUploads.current.forEach((controller) => controller.abort());
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MANIFEST_KEY);
      const saved = raw ? (JSON.parse(raw) as Q.Persisted[]) : null;
      if (Array.isArray(saved) && saved.length > 0) {
        dispatch({ type: "restore", saved, now: Date.now() });
      }
    } catch {
      /* no storage / bad JSON: start empty */
    }
  }, []);
  // The manifest carries no progress, so it only ever changes when an item is
  // added, dropped, or changes status — and progress ticks dominate queue
  // changes. Compare that cheap key first so the ticks skip building the
  // manifest at all, not just the write.
  useEffect(() => {
    const key = queue.items.map((i) => `${i.photoId}:${i.status}:${i.uploadIdentity?.attemptId ?? ""}:${i.sidecarRetry ?? false}`).join(",");
    if (key === persistedKey.current) return;
    persistedKey.current = key;
    try {
      localStorage.setItem(
        MANIFEST_KEY,
        JSON.stringify(Q.toManifest(queue, Date.now()))
      );
    } catch {
      /* ignore */
    }
  }, [queue]);

  // Leave-page prompt while anything is in flight.
  const active = Q.isActive(queue);
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  // Sequential runner: one file at a time until nothing is queued. Reads
  // queueRef for the CURRENT queue after each await (dispatches are async).
  // The final complete/fail dispatch re-runs this effect after running goes
  // false, so anything enqueued mid-run always gets picked up.
  useEffect(() => {
    if (running.current) return;
    const next = Q.nextQueued(queue);
    if (!next) return;
    running.current = true;
    void (async () => {
      const deps = buildBrowserUploadDeps();
      let item: Q.QueueItem | null = next;
      let any = false;
      let failed = 0;
      let duplicates = 0;
      const processed = new Set<string>();
      // Counts come from the run itself, not from queueRef afterwards: the
      // last file's dispatch may not have rendered by the time we get here.
      try {
        while (item && !unmounted.current) {
          const current = item;
          processed.add(current.photoId);
          const entry = queueRef.current.files.get(current.photoId);
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (unmounted.current) break;
          const live = queueRef.current.items.find((candidate) => candidate.photoId === current.photoId);
          if (!live || live.status !== "queued") {
            item = queueRef.current.items.find((candidate) => candidate.status === "queued" && !processed.has(candidate.photoId)) ?? null;
            continue;
          }
          if (!entry || !session) {
            failed += 1;
            dispatch({
              type: "fail",
              photoId: current.photoId,
              error: entry
                ? "Signed out — sign in and retry"
                : "File no longer available — re-pick it",
            });
          } else {
            dispatch({ type: "start", photoId: current.photoId });
            const id = current.photoId;
            const controller = new AbortController();
            inFlight.current = { photoId: id, controller };
            const result = await uploadOne(
              entry.file,
              id,
              {
                jobId: current.jobId,
                uploaderId: session.user.id,
                sheetNumber: current.sheetNumber,
                tags: current.tags,
              },
              deps,
              (sent) => {
                if (unmounted.current) return;
                dispatch({ type: "progress", photoId: id, sentBytes: sent });
              },
              {
                shutter: current.shutterAt
                  ? new Date(current.shutterAt)
                  : undefined,
                sidecar: entry.sidecar,
                expectedSidecarName: current.sidecarName,
                signal: controller.signal,
                identity: current.uploadIdentity,
                onIdentity: (identity) => dispatchCurrent({ type: "identity", photoId: id, identity }),
              }
            );
            inFlight.current = null;
            if (unmounted.current) break;
            const after = queueRef.current.items.find((candidate) => candidate.photoId === id);
            if (!after || Q.isRemoving(after) || removals.current.has(id) || removedTransfers.current.has(id)) {
              removedTransfers.current.delete(id);
              item = queueRef.current.items.find((candidate) => candidate.status === "queued" && !processed.has(candidate.photoId)) ?? null;
              continue;
            }
            console.info(
              `photos.upload photoId=${id} status=${result.status}${result.error ? ` err=${result.error}` : ""}`
            );
            if (result.status === "done") {
              any = true;
            } else if (result.status === "duplicate") {
              duplicates += 1;
            } else {
              failed += 1;
            }
            dispatch({ type: "outcome", photoId: id, result });
          }
          item = queueRef.current.items.find((candidate) =>
            candidate.status === "queued" && !processed.has(candidate.photoId)) ?? null;
        }
      } catch (e) {
        // Everything inside the loop that can reject per file is already
        // handled by uploadOne; a throw reaching here is the surrounding
        // machinery (the session lookup, storage). Fail the item we were on
        // so it lands in the tray with a retry instead of sitting queued
        // behind a lock that never clears.
        console.error("photos.upload runner aborted", e);
        const failedId = item?.photoId;
        const failedItem = queueRef.current.items.find((candidate) => candidate.photoId === failedId);
        if (failedItem && !unmounted.current && !Q.isRemoving(failedItem) && !removedTransfers.current.has(failedItem.photoId)) {
          failed += 1;
          dispatch({
            type: "fail",
            photoId: failedItem.photoId,
            error:
              e instanceof Error && e.message
                ? `Upload interrupted — ${e.message}`
                : "Upload interrupted — retry",
          });
        }
      } finally {
        // The one release: a throw above must never strand the queue, because
        // every later run of this effect exits early while it is held.
        running.current = false;
      }
      if (unmounted.current) return;
      // A duplicate may have been restored or moved by a separate action page.
      if (any || duplicates) invalidatePhotoCaches(queryClient);
      if (failed) {
        toast.error(
          `${plural(failed, "upload")} needs attention — open the tray`
        );
      } else if (any) {
        toast.success("Upload complete");
      } else if (duplicates) {
        toast.success(`${plural(duplicates, "photo")} already in this job`);
      }
    })();
  }, [queue, queryClient, dispatchCurrent]);

  const value: Manager = {
    items: queue.items,
    active,
    enqueue: (files, meta) =>
      dispatch({ type: "enqueue", files, meta, now: Date.now() }),
    retry: (photoId) => dispatch({ type: "retry", photoId }),
    retrySidecar: (photoId, sidecar) => {
      const item = queueRef.current.items.find((candidate) => candidate.photoId === photoId);
      if (!item?.sidecarRetry || !item.uploadIdentity || sidecarUploads.current.has(photoId) || (item.retryAt ?? 0) > Date.now()) return;
      const identity = item.uploadIdentity;
      const controller = new AbortController();
      sidecarUploads.current.set(photoId, controller);
      dispatch({ type: "startSidecar", photoId });
      void (async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error("Sign in to retry the XMP sidecar.");
          const result = await uploadSidecar(sidecar, identity, {
            uploaderId: session.user.id, jobId: item.jobId,
          }, buildBrowserUploadDeps(), { signal: controller.signal });
          if (unmounted.current) return;
          // The original already committed. A failed XMP retry keeps that
          // success and its dedicated reselection action visible.
          dispatch({ type: "outcome", photoId, result: {
            ...result,
            status: result.status === "failed" || result.status === "cancelled" ? "done" : result.status,
            warnings: result.status === "failed" || result.status === "cancelled"
              ? [...new Set([...(item.warnings ?? []), ...result.warnings])]
              : result.warnings,
            sidecarRetry: result.sidecarRetry ?? result.status !== "done",
          } });
          if (result.status === "done" && !result.sidecarRetry) {
            invalidatePhotoCaches(queryClient);
            toast.success("XMP sidecar saved");
          }
        } catch (error) {
          if (!unmounted.current) dispatch({ type: "outcome", photoId, result: {
            status: "done", warnings: item.warnings ?? [], sidecarRetry: true,
            error: error instanceof Error ? error.message : "Sidecar retry failed",
          } });
        } finally {
          sidecarUploads.current.delete(photoId);
        }
      })();
    },
    remove: (photoId) => {
      const item = queueRef.current.items.find((candidate) => candidate.photoId === photoId);
      if (!item || removals.current.has(photoId)) return;
      if (inFlight.current?.photoId === photoId) {
        removedTransfers.current.add(photoId);
        inFlight.current.controller.abort();
      }
      sidecarUploads.current.get(photoId)?.abort();
      // Dismissing a settled row also dismisses its sidecar warning. It never
      // invokes photo deletion. Unfinished attempts require durable cancellation.
      if (item.status === "done" || item.status === "duplicate" || !item.uploadIdentity) {
        dispatchCurrent({ type: "remove", photoId });
        return;
      }
      removals.current.add(photoId);
      dispatchCurrent({ type: "beginRemoval", photoId });
      void (async () => {
        try {
          const result = await cancelBrowserUpload(Q.cancellationInput(item)!);
          dispatchCurrent({ type: "finishRemoval", photoId, result });
          if (result.status !== "cancelled") invalidatePhotoCaches(queryClient);
        } catch (error) {
          dispatchCurrent({ type: "removalFailed", photoId,
            error: error instanceof Error ? error.message : "Unable to confirm cancellation." });
          if (!unmounted.current) toast.error("Upload removal is pending — retry removal in the tray");
        } finally {
          removals.current.delete(photoId);
          // A tab may leave while the cancellation request is settling. Keep
          // its durable retry handle even when React can no longer persist it.
          if (unmounted.current) {
            try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(Q.toManifest(queueRef.current, Date.now()))); } catch { /* no storage */ }
          }
        }
      })();
    },
    repick: (files) => {
      dispatch({ type: "repick", files });
      // The reducer is the source of truth for the queue; this second
      // adoptRepick pass is deliberate and only reads `unmatched` for the
      // toast, where a slightly stale queue is harmless.
      return Q.adoptRepick(queueRef.current, files).unmatched;
    },
    dismissDone: () => dispatch({ type: "dismissDone" }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
