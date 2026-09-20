import { isSha256 } from "./apiShared";

export type HashOptions = { signal?: AbortSignal };
export type HashWorkerReply = { digest: string } | { error: string };
export type HashWorker = Pick<Worker,
  "onmessage" | "onerror" | "onmessageerror" | "postMessage" | "terminate"
>;

const HASH_CONCURRENCY = 2;

/** The factory seam lets tests exercise scheduling without a browser runtime. */
export function createSha256(createWorker: () => HashWorker) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const drain = () => {
    while (active < HASH_CONCURRENCY && waiting.length) waiting.shift()!();
  };

  return function hash(file: Blob, { signal }: HashOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      let worker: HashWorker | undefined;
      let started = false;
      let settled = false;
      const finish = (error?: Error, digest?: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
        }
        if (started) active--;
        else {
          const index = waiting.indexOf(start);
          if (index !== -1) waiting.splice(index, 1);
        }
        if (error) reject(error);
        else resolve(digest!);
        drain();
      };
      const abort = () => finish(new DOMException("Hashing cancelled", "AbortError"));
      const start = () => {
        started = true;
        active++;
        try {
          worker = createWorker();
          worker.onmessage = (event: MessageEvent<HashWorkerReply>) => {
            const reply = event.data;
            if (reply && "digest" in reply && isSha256(reply.digest)) {
              finish(undefined, reply.digest);
            } else {
              finish(new Error(reply && "error" in reply ? reply.error : "Invalid hash worker response"));
            }
          };
          worker.onerror = () => finish(new Error("Hash worker failed"));
          worker.onmessageerror = () => finish(new Error("Hash worker response could not be read"));
          // A Blob is structured-cloned without accumulating its contents here.
          worker.postMessage(file);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Hash worker failed"));
        }
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      waiting.push(start);
      drain();
    });
  };
}

// Shared across ordinary and migration callers; no main-thread or null fallback.
export const sha256 = createSha256(() =>
  new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" })
);
