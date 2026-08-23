"use client";

// App-level upload manager: owns the queue (upload-queue.ts) and runs it one
// file at a time, so uploads keep going while the user navigates between
// photos pages. The queue's metadata persists to localStorage as a manifest;
// after a reload the entries come back as "interrupted" and the user re-picks
// the files to resume (browsers can't hold File handles across reloads).

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabaseClient";
import { invalidatePhotoCaches, fetchJson } from "./api";
import * as Q from "./upload-queue";
import { pairByBasename } from "./sidecar";
import {
  createResumableUpload,
  uploadOne,
  type BatchMeta,
  type UploadDeps,
} from "./upload";
import { extractCapturedAt } from "./exif";

const MANIFEST_KEY = "photos.upload-manifest";

type Action =
  | { type: "enqueue"; files: File[]; meta: BatchMeta; now: number }
  | { type: "start" | "complete" | "retry" | "remove" | "duplicate"; photoId: string }
  | { type: "progress"; photoId: string; sentBytes: number }
  | { type: "fail"; photoId: string; error: string }
  | { type: "restore"; saved: Q.Persisted[]; now: number }
  | { type: "repick"; files: File[] }
  | { type: "dismissDone" };

function reducer(q: Q.Queue, a: Action): Q.Queue {
  switch (a.type) {
    case "enqueue":
      return Q.enqueue(q, a.files, a.meta, a.now).queue;
    case "start":
      return Q.start(q, a.photoId);
    case "progress":
      return Q.progress(q, a.photoId, a.sentBytes);
    case "complete":
      return Q.complete(q, a.photoId);
    case "fail":
      return Q.fail(q, a.photoId, a.error);
    case "duplicate":
      return Q.markDuplicate(q, a.photoId);
    case "retry":
      return Q.retry(q, a.photoId);
    case "remove":
      return Q.remove(q, a.photoId);
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
  enqueue(files: File[], meta: BatchMeta): void;
  retry(photoId: string): void;
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

function buildDeps(): UploadDeps {
  return {
    extractCapturedAt,
    storage: {
      async upload(path, body, options) {
        const { error } = await supabase.storage
          .from("photos")
          .upload(path, body, options);
        return { error };
      },
      async remove(paths) {
        const { error } = await supabase.storage.from("photos").remove(paths);
        return { error };
      },
    },
    resumableUpload: createResumableUpload({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      getAccessToken: async () =>
        (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }),
    finalize: (payload) =>
      fetchJson<{ alreadyExists?: boolean; duplicate?: boolean }>(
        "/api/photos",
        "Saving failed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      ),
    exists: async (jobId, sha) => {
      const data = await fetchJson<{ exists: boolean }>(
        `/api/photos/exists?job=${encodeURIComponent(jobId)}&sha=${encodeURIComponent(sha)}`,
        "Duplicate check failed"
      );
      return data.exists;
    },
  };
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

  // Restore the manifest once; persist on every change.
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
  useEffect(() => {
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
      const deps = buildDeps();
      let item: Q.QueueItem | null = next;
      let any = false;
      while (item) {
        const current = item;
        const entry = queueRef.current.files.get(current.photoId);
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!entry || !session) {
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
            (sent) =>
              dispatch({ type: "progress", photoId: id, sentBytes: sent }),
            {
              shutter: current.shutterAt
                ? new Date(current.shutterAt)
                : undefined,
              sidecar: entry.sidecar,
            }
          );
          console.info(
            `photos.upload photoId=${id} status=${result.status}${result.error ? ` err=${result.error}` : ""}`
          );
          if (result.status === "done") {
            any = true;
            dispatch({ type: "complete", photoId: id });
          } else if (result.status === "duplicate") {
            dispatch({ type: "duplicate", photoId: id });
          } else {
            dispatch({
              type: "fail",
              photoId: id,
              error: result.error ?? "Upload failed",
            });
          }
        }
        item = Q.nextQueued(queueRef.current);
      }
      running.current = false;
      if (any) invalidatePhotoCaches(queryClient);
      const failed = queueRef.current.items.filter(
        (i) => i.status === "failed"
      ).length;
      if (failed) {
        toast.error(
          `${failed} upload${failed === 1 ? "" : "s"} failed — open the tray to retry`
        );
      } else if (any) {
        toast.success("Upload complete");
      }
    })();
  }, [queue, queryClient]);

  const value: Manager = {
    items: queue.items,
    active,
    enqueue: (files, meta) => {
      // Safety net: pick-time pairing (useCaptureBatch) already rejected
      // lone sidecars; anything that still slips through gets named here.
      const { rejected } = pairByBasename(files);
      for (const r of rejected) toast.error(`${r.name} ${r.reason}`);
      dispatch({ type: "enqueue", files, meta, now: Date.now() });
    },
    retry: (photoId) => dispatch({ type: "retry", photoId }),
    remove: (photoId) => dispatch({ type: "remove", photoId }),
    repick: (files) => {
      const { unmatched } = Q.adoptRepick(queueRef.current, files);
      dispatch({ type: "repick", files });
      return unmatched;
    },
    dismissDone: () => dispatch({ type: "dismissDone" }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
