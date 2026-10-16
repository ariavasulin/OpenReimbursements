"use client";

// App-level upload manager: owns the queue (upload-queue.ts) and runs it so
// uploads keep going while the user navigates between photos pages. One
// file's bytes go at a time; while they are on the network the NEXT file is
// prepared (hashed, dated, previews made), so the phone's processor and its
// connection work at the same time instead of taking turns. The queue's
// metadata persists to localStorage as a manifest; after a reload the entries
// come back as "interrupted" and the user re-picks the files to resume
// (browsers can't hold File handles across reloads).
//
// The code that does the uploading (hashing, EXIF, previews, the resumable
// transfer: about 50 KB gzipped) is loaded on first use, not with every photos page
// (SHELL-2). Only this file's queue bookkeeping ships up front.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabaseClient";
import { invalidateAfterUpload, photoKeys } from "./api";
import { reloadIfRedeployed } from "./redeploy";
import * as Q from "./upload-queue";
import type {
  BatchMeta,
  PreparedUpload,
  ServerDerive,
  UploadIdentity,
  UploadResult,
} from "./upload";
import { plural } from "./format";
import type { CancelUploadOutcome } from "./upload-contract";
import { createTaskLimiter } from "./task-limiter";

let engine: ReturnType<typeof importEngine> | undefined;
const importEngine = () =>
  Promise.all([import("./upload"), import("./upload-browser")]).then(([u, b]) => ({
    uploadOne: u.uploadOne,
    uploadSidecar: u.retrySidecar,
    prepareUpload: u.prepareUpload,
    isConnectionFailure: u.isConnectionFailure,
    isLeaseBusy: u.isLeaseBusy,
    withoutPreviewNotes: u.withoutPreviewNotes,
    buildBrowserUploadDeps: b.buildBrowserUploadDeps,
    cancelBrowserUpload: b.cancelBrowserUpload,
  }));
/** The upload code, fetched once. A failed fetch (a dropped connection) is
 * not remembered, so the next upload or retry fetches again. */
function loadEngine() {
  engine ??= importEngine().catch((error: unknown) => {
    engine = undefined;
    // After a deploy the old file is gone for good: move onto the new build.
    void reloadIfRedeployed(error);
    throw error;
  });
  return engine;
}
/** Start fetching the upload code before it is needed, e.g. when the upload
 * sheet opens, so the first file does not wait on it. */
export function preloadUploadEngine() {
  void loadEngine().catch(() => undefined);
}

const MANIFEST_KEY = "photos.upload-manifest";
/** An earlier try's lease runs out within two minutes, so one wait is enough;
 *  needing more means something else holds it, and the row fails with a retry. */
const LEASE_WAITS = 3;
/** Past the lease's end, so the next try finds it free. */
const LEASE_GRACE_MS = 1_000;
/** Server-made previews in flight at once; the rest wait their turn. */
const SERVER_DERIVES_AT_ONCE = 2;

type Action =
  | { type: "enqueue"; files: Q.PairedFile[]; meta: BatchMeta; now: number }
  | { type: "start" | "retry" | "keep" | "remove"; photoId: string }
  | { type: "retryAll"; now: number }
  | { type: "progress"; photoId: string; sentBytes: number }
  | { type: "stage"; photoId: string; stage: Q.QueueStage }
  /** Carries the upload code's own filter, which this file does not load up front. */
  | { type: "previewsMade"; photoId: string; withoutPreviewNotes: (warnings: string[]) => string[] }
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
    case "stage":
      return Q.setStage(q, a.photoId, a.stage);
    case "previewsMade":
      return Q.keepWarnings(q, a.photoId, (warning) => a.withoutPreviewNotes([warning]).length > 0);
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
    case "retryAll":
      return Q.retryAll(q, a.now);
    case "keep":
      return Q.keep(q, a.photoId);
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

interface UploadState {
  items: Q.QueueItem[];
  active: boolean;
}

/** The manager's actions. They never change identity, so a component that only acts (the upload sheet) does not re-render on progress. */
export interface UploadActions {
  enqueue(files: Q.PairedFile[], meta: BatchMeta): void;
  retry(photoId: string): void;
  /** Retry every failed row that may be retried now. */
  retryAll(): void;
  /** Upload a held format twin anyway. */
  keep(photoId: string): void;
  retrySidecar(photoId: string, sidecar: File): void;
  remove(photoId: string): void;
  /** Adopts re-picked files into interrupted entries; returns the files that
   * matched nothing (so the tray can name them in a toast). */
  repick(files: File[]): File[];
  dismissDone(): void;
}

type Manager = UploadState & UploadActions;

const StateCtx = createContext<UploadState | null>(null);
const ActionsCtx = createContext<UploadActions | null>(null);

export const useUploadActions = () => {
  const actions = useContext(ActionsCtx);
  if (!actions) throw new Error("useUploadActions outside UploadManagerProvider");
  return actions;
};

export const useUploadManager = (): Manager => {
  const state = useContext(StateCtx);
  const actions = useContext(ActionsCtx);
  if (!state || !actions) throw new Error("useUploadManager outside UploadManagerProvider");
  return { ...state, ...actions };
};

/**
 * Wait `ms`, or less: the browser saying it is back online, or the page
 * coming back to the front (iOS pauses a page in the background), ends the
 * wait early. Neither is trusted to mean the connection works; they only
 * decide when to try again. Ends at once when `signal` aborts.
 */
function waitForConnection(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", soon);
      document.removeEventListener("visibilitychange", visible);
      signal.removeEventListener("abort", done);
      resolve();
    };
    // A second's grace: "online" fires as the radio comes up, before data flows.
    const soon = () => { clearTimeout(timer); timer = setTimeout(done, 1_000); };
    const visible = () => { if (document.visibilityState === "visible") soon(); };
    let timer = setTimeout(done, ms);
    if (signal.aborted) return done();
    window.addEventListener("online", soon);
    document.addEventListener("visibilitychange", visible);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Wait `ms`, ending at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Whether the picked file can still be read. A phone may revoke a picked file
 * (iOS, after the page sat in the background); every try would then fail the
 * same way and look like a dropped connection, holding the batch for half an
 * hour. Reading one byte is local and costs no request.
 */
async function stillReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Ask the screen to stay on while uploads run. Feature-detected: older Safari has no wake lock. */
function useScreenWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | undefined;
    let stopped = false;
    // The browser drops the lock whenever the page is hidden; take it again on return.
    const acquire = () => {
      if (stopped || sentinel || document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then((lock) => {
        if (stopped) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", () => {
          if (sentinel === lock) sentinel = undefined;
        });
      }).catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [on]);
}

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
  // The next file, prepared while the current one sends. At most one, so at
  // most one photo is decoded ahead.
  const ahead = useRef<{ photoId: string; file: File; controller: AbortController; prepared: PreparedUpload } | null>(null);
  const derives = useRef(createTaskLimiter(SERVER_DERIVES_AT_ONCE));
  const sidecarUploads = useRef(new Map<string, AbortController>());
  const removals = useRef(new Set<string>());
  const removedTransfers = useRef(new Set<string>());
  // Async callbacks must see a Remove/identity transition before React renders.
  const dispatchCurrent = useCallback((action: Action) => {
    queueRef.current = reducer(queueRef.current, action);
    dispatch(action);
  }, []);
  // A finished upload changes the grids, the project and album cards, and
  // the tags; not Trash or the deleted lists. The photos whose own record
  // changed (previews made, an XMP attached, an existing photo added to the
  // upload's albums) also refresh, in case one is open.
  const refreshAfterUpload = useCallback((...photoIds: string[]) => {
    invalidateAfterUpload(queryClient);
    for (const photoId of photoIds) void queryClient.invalidateQueries({ queryKey: photoKeys.detail(photoId) });
  }, [queryClient]);
  const dropAhead = useCallback(() => {
    ahead.current?.controller.abort();
    ahead.current = null;
  }, []);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      inFlight.current?.controller.abort();
      dropAhead();
      sidecarUploads.current.forEach((controller) => controller.abort());
    };
  }, [dropAhead]);

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
  // A dimming screen locks the phone, and a locked phone stops the upload.
  useScreenWakeLock(active);

  // The runner: one file's bytes at a time until nothing is queued. Reads
  // queueRef for the CURRENT queue after each await (dispatches are async).
  // The final complete/fail dispatch re-runs this effect after running goes
  // false, so anything enqueued mid-run always gets picked up.
  useEffect(() => {
    if (running.current) return;
    const next = Q.nextQueued(queue);
    if (!next) return;
    running.current = true;
    void (async () => {
      const progressGate = Q.createProgressGate();
      let item: Q.QueueItem | null = next;
      let any = false;
      let failed = 0;
      let duplicates = 0;
      // The existing photos the duplicates matched: each may now be in this upload's albums.
      const matched = new Set<string>();
      const processed = new Set<string>();
      const nextCandidate = (except?: string) => queueRef.current.items.find((candidate) =>
        candidate.status === "queued" && !processed.has(candidate.photoId) && candidate.photoId !== except) ?? null;
      // Counts come from the run itself, not from queueRef afterwards: the
      // last file's dispatch may not have rendered by the time we get here.
      try {
        // Inside the try: if the upload code cannot be fetched, the file we
        // were on fails with a retry (below) instead of the queue sticking.
        const { buildBrowserUploadDeps, prepareUpload, uploadOne, isConnectionFailure, isLeaseBusy, withoutPreviewNotes } =
          await loadEngine().catch(() => {
            throw new Error("the upload code did not load; check the connection");
          });
        const deps = buildBrowserUploadDeps();
        const prepare = (candidate: Q.QueueItem, entry: Q.PairedFile, controller: AbortController) =>
          prepareUpload(entry.file, deps, {
            shutter: candidate.shutterAt ? new Date(candidate.shutterAt) : undefined,
            sidecar: entry.sidecar,
            signal: controller.signal,
          });
        // Called when the current file starts sending: start on the next one.
        const warmNext = (currentId: string) => {
          if (ahead.current || unmounted.current) return;
          const candidate = nextCandidate(currentId);
          const entry = candidate ? queueRef.current.files.get(candidate.photoId) : undefined;
          if (!candidate || !entry) return;
          const controller = new AbortController();
          const prepared = prepare(candidate, entry, controller);
          prepared.warm();
          ahead.current = { photoId: candidate.photoId, file: entry.file, controller, prepared };
        };
        // Server previews run beside the queue; the row's note goes when they land.
        // Keyed by the queue row, not the server's photo id (a reset attempt has a new one).
        const deriveLater = (queueId: string, photoId: string, derive: ServerDerive) => {
          void derives.current.run(derive).then((made) => {
            if (unmounted.current || !made.thumb_path) return;
            dispatchCurrent({ type: "previewsMade", photoId: queueId, withoutPreviewNotes });
            refreshAfterUpload(photoId);
          }).catch(() => undefined); // Left to the nightly sweep; the note stands.
        };
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
            item = nextCandidate();
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
            // Use the preparation made while the previous file sent, when it
            // is for this very file; any other is stale, so stop it.
            const ready = ahead.current?.photoId === id && ahead.current.file === entry.file ? ahead.current : null;
            if (!ready) dropAhead();
            ahead.current = null;
            const controller = ready?.controller ?? new AbortController();
            const prepared = ready?.prepared ?? prepare(current, entry, controller);
            inFlight.current = { photoId: id, controller };
            const attempt = (heldLease?: number) => uploadOne(
              entry.file,
              id,
              {
                jobId: current.jobId,
                albumIds: current.albumIds,
                uploaderId: session.user.id,
                tags: current.tags,
              },
              deps,
              (sent, total) => {
                if (unmounted.current || !progressGate(id, sent, total)) return;
                dispatch({ type: "progress", photoId: id, sentBytes: sent });
              },
              {
                shutter: current.shutterAt
                  ? new Date(current.shutterAt)
                  : undefined,
                sidecar: entry.sidecar,
                expectedSidecarName: current.sidecarName,
                signal: controller.signal,
                // A try after a dropped connection reuses the identity the
                // last try recorded, so it resumes rather than starting over.
                identity: queueRef.current.items.find((candidate) => candidate.photoId === id)?.uploadIdentity
                  ?? current.uploadIdentity,
                keepFormatTwin: current.keepFormatTwin,
                prepared,
                onIdentity: (identity) => dispatchCurrent({ type: "identity", photoId: id, identity }),
                onStage: (stage) => {
                  if (unmounted.current) return;
                  dispatch({ type: "stage", photoId: id, stage });
                  if (stage === "sending") warmNext(id);
                },
                deriveLater: (photoId, derive) => deriveLater(id, photoId, derive),
                heldLease,
              }
            );
            let result = await attempt();
            // The connection dropped (a dead spot, a lift, a basement): hold
            // the batch on this file and try it again as the signal returns,
            // instead of failing it and every file after it in turn.
            const pausedAt = Date.now();
            for (let wait = 1, leaseWaits = 0; !controller.signal.aborted && !unmounted.current
                && Date.now() - pausedAt < Q.RECONNECT_GIVE_UP_MS; wait++) {
              if (isConnectionFailure(result)) {
                dispatch({ type: "stage", photoId: id, stage: "reconnecting" });
                await waitForConnection(Q.reconnectDelay(wait), controller.signal);
              } else if (isLeaseBusy(result) && leaseWaits < LEASE_WAITS) {
                // The try the connection cut off still holds its lease (its
                // release was lost too). Wait for the lease to run out, then
                // carry on, rather than failing the file.
                leaseWaits += 1;
                dispatch({ type: "stage", photoId: id, stage: "reconnecting" });
                await pause(Math.max(0, result.retryAt - Date.now()) + LEASE_GRACE_MS, controller.signal);
              } else {
                break;
              }
              if (controller.signal.aborted || unmounted.current) break;
              if (!await stillReadable(entry.file)) {
                result = { status: "failed", error: "File can no longer be read — re-pick it", warnings: result.warnings };
                break;
              }
              result = await attempt(result.heldLease);
            }
            inFlight.current = null;
            if (unmounted.current) break;
            const after = queueRef.current.items.find((candidate) => candidate.photoId === id);
            if (!after || Q.isRemoving(after) || removals.current.has(id) || removedTransfers.current.has(id)) {
              removedTransfers.current.delete(id);
              item = nextCandidate();
              continue;
            }
            console.info(
              `photos.upload photoId=${id} status=${result.status}${result.error ? ` err=${result.error}` : ""}`
            );
            if (result.status === "done") {
              any = true;
            } else if (result.status === "duplicate") {
              duplicates += 1;
              if (result.canonicalPhotoId) matched.add(result.canonicalPhotoId);
            } else {
              failed += 1;
            }
            dispatch({ type: "outcome", photoId: id, result });
          }
          item = nextCandidate();
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
      // A duplicate may have been moved into this upload's album.
      if (any || duplicates) refreshAfterUpload(...matched);
      if (failed) {
        toast.error(
          `${plural(failed, "upload")} needs attention — open the tray`
        );
      } else if (any) {
        toast.success("Upload complete");
      } else if (duplicates) {
        toast.success(`${plural(duplicates, "photo")} already in Photos`);
      }
    })();
  }, [queue, dispatchCurrent, dropAhead, refreshAfterUpload]);

  const state = useMemo<UploadState>(() => ({ items: queue.items, active }), [queue.items, active]);
  const actions = useMemo<UploadActions>(() => ({
    enqueue: (files, meta) =>
      dispatch({ type: "enqueue", files, meta, now: Date.now() }),
    retry: (photoId) => dispatch({ type: "retry", photoId }),
    retryAll: () => dispatch({ type: "retryAll", now: Date.now() }),
    keep: (photoId) => dispatch({ type: "keep", photoId }),
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
          const { uploadSidecar, buildBrowserUploadDeps } = await loadEngine();
          const result = await uploadSidecar(sidecar, identity, {
            uploaderId: session.user.id, jobId: item.jobId, albumIds: item.albumIds,
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
            refreshAfterUpload(identity.photoId);
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
      if (ahead.current?.photoId === photoId) dropAhead();
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
          const { cancelBrowserUpload } = await loadEngine();
          const result = await cancelBrowserUpload(Q.cancellationInput(item)!);
          dispatchCurrent({ type: "finishRemoval", photoId, result });
          // Too late to cancel: the upload had already finished on the server.
          if (result.status !== "cancelled") refreshAfterUpload();
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
  }), [dispatchCurrent, dropAhead, refreshAfterUpload]);
  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}
