import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSha256, sha256, type HashWorker, type HashWorkerReply } from "./hash";
import { HASH_CHUNK_BYTES, hashBlob } from "./hash-core";

const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

class ControlledWorker implements HashWorker {
  onmessage: HashWorker["onmessage"] = null;
  onerror: HashWorker["onerror"] = null;
  onmessageerror: HashWorker["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  reply(data: HashWorkerReply) {
    this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data }));
  }
}

function scheduler() {
  const workers: ControlledWorker[] = [];
  const factory = vi.fn(() => {
    const worker = new ControlledWorker();
    workers.push(worker);
    return worker;
  });
  return { hash: createSha256(factory), factory, workers };
}

afterEach(() => vi.unstubAllGlobals());

describe("incremental SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", ABC_SHA],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ])("hashes the known vector %j", async (input, digest) => {
    await expect(hashBlob(new Blob([input]))).resolves.toBe(digest);
  });

  it.each([3, HASH_CHUNK_BYTES, HASH_CHUNK_BYTES + 1, 2 * HASH_CHUNK_BYTES + 17])(
    "matches the independent SHA-256 reference for single/multiple slices (%i bytes)",
    async (size) => {
      const bytes = new Uint8Array(size).map((_, i) => i % 251);
      const file = new Blob([bytes]);
      const fullRead = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("whole-file read"));
      await expect(hashBlob(file)).resolves.toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(fullRead).not.toHaveBeenCalled();
    }
  );

  it("hashes a lazy >100 MiB source using only sequential 6 MiB slices", async () => {
    const size = 101 * 1024 * 1024 + 13;
    const ranges: number[][] = [];
    let reading = 0;
    let peakReads = 0;
    const file = {
      size,
      arrayBuffer: vi.fn(() => { throw new Error("whole-file read"); }),
      slice: vi.fn((start: number, end: number) => {
        ranges.push([start, end]);
        return {
          arrayBuffer: async () => {
            peakReads = Math.max(peakReads, ++reading);
            const bytes = new Uint8Array(end - start).fill(97);
            await Promise.resolve();
            reading--;
            return bytes.buffer;
          },
        };
      }),
    } as unknown as Blob;
    const reference = createHash("sha256");
    const oneMiB = new Uint8Array(1024 * 1024).fill(97);
    for (let i = 0; i < 101; i++) reference.update(oneMiB);
    reference.update(new Uint8Array(13).fill(97));
    await expect(hashBlob(file)).resolves.toBe(reference.digest("hex"));
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(peakReads).toBe(1);
    expect(ranges).toEqual(Array.from({ length: Math.ceil(size / HASH_CHUNK_BYTES) }, (_, i) =>
      [i * HASH_CHUNK_BYTES, Math.min((i + 1) * HASH_CHUNK_BYTES, size)]
    ));
  });

  it("stops between slices when cancelled while a read is pending", async () => {
    const controller = new AbortController();
    let finishRead!: (value: ArrayBuffer) => void;
    const slice = vi.fn(() => ({ arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) }));
    const result = hashBlob({ size: HASH_CHUNK_BYTES + 1, slice } as unknown as Blob, { signal: controller.signal });
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    finishRead(new ArrayBuffer(HASH_CHUNK_BYTES));
    await rejected;
    expect(slice).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete read and a source I/O failure", async () => {
    await expect(hashBlob({ size: 10, slice: () => new Blob(["abc"]) } as unknown as Blob)).rejects.toThrow("incomplete");
    await expect(hashBlob({ size: 10, slice: () => { throw new Error("drive unavailable"); } } as unknown as Blob)).rejects.toThrow("drive unavailable");
  });
});

describe("hash worker scheduling", () => {
  it("starts at most two files and starts the next only after terminating a finished worker", async () => {
    const { hash, workers } = scheduler();
    const files = Array.from({ length: 5 }, () => new Blob(["abc"]));
    const results = files.map((file) => hash(file));
    expect(workers).toHaveLength(2);
    for (let i = 0; i < files.length; i++) {
      expect(workers[i].postMessage).toHaveBeenCalledWith(files[i]);
      workers[i].reply({ digest: ABC_SHA });
      expect(workers[i].terminate).toHaveBeenCalledOnce();
      expect(workers.filter((worker) => !worker.terminate.mock.calls.length).length).toBeLessThanOrEqual(2);
    }
    await expect(Promise.all(results)).resolves.toEqual(files.map(() => ABC_SHA));
  });

  it("cancels queued work without creating a worker or reading its bytes", async () => {
    const { hash, workers } = scheduler();
    const first = hash(new Blob(["abc"]));
    const second = hash(new Blob(["abc"]));
    const controller = new AbortController();
    const file = new Blob(["queued"]);
    const read = vi.spyOn(file, "arrayBuffer");
    const pending = hash(file, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    workers[0].reply({ digest: ABC_SHA });
    workers[1].reply({ digest: ABC_SHA });
    await Promise.all([first, second]);
    expect(workers).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
  });

  it("terminates an active cancelled worker immediately and gives its slot to the next file", async () => {
    const { hash, workers } = scheduler();
    const controller = new AbortController();
    const first = hash(new Blob(["abc"]), { signal: controller.signal });
    const second = hash(new Blob(["abc"]));
    const third = hash(new Blob(["abc"]));
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(3);
    workers[0].reply({ digest: ABC_SHA }); // A stale worker cannot resolve or free another slot.
    workers[1].reply({ digest: ABC_SHA });
    workers[2].reply({ digest: ABC_SHA });
    await rejected;
    await expect(Promise.all([second, third])).resolves.toEqual([ABC_SHA, ABC_SHA]);
  });

  it("never starts an already-aborted request", async () => {
    const { hash, factory } = scheduler();
    await expect(hash(new Blob(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64)])("rejects noncanonical worker digest %s", async digest => {
    const { hash, workers } = scheduler();
    const pending = hash(new Blob());
    workers[0].reply({ digest });
    await expect(pending).rejects.toThrow("Invalid hash worker response");
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it.each(["reply", "error", "messageerror"])("rejects %s failures and releases the worker slot", async (kind) => {
    const { hash, workers } = scheduler();
    const result = hash(new Blob());
    const rejected = expect(result).rejects.toThrow();
    if (kind === "reply") workers[0].reply({ error: "drive unavailable" });
    else if (kind === "error") workers[0].onerror?.call(workers[0] as unknown as Worker, new Event("error") as ErrorEvent);
    else workers[0].onmessageerror?.call(workers[0] as unknown as Worker, new MessageEvent("messageerror"));
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = hash(new Blob());
    workers[1].reply({ digest: ABC_SHA });
    await expect(retry).resolves.toBe(ABC_SHA);
  });

  it("rejects a worker startup failure and can retry", async () => {
    const worker = new ControlledWorker();
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error("worker unavailable"); }).mockReturnValue(worker);
    const hash = createSha256(factory);
    await expect(hash(new Blob())).rejects.toThrow("worker unavailable");
    const retry = hash(new Blob());
    worker.reply({ digest: ABC_SHA });
    await expect(retry).resolves.toBe(ABC_SHA);
  });

  it("the public API creates the module worker and returns its digest", async () => {
    let url!: URL;
    let options!: WorkerOptions;
    class TestWorker extends ControlledWorker {
      constructor(workerUrl: URL, workerOptions: WorkerOptions) {
        super();
        url = workerUrl;
        options = workerOptions;
        this.postMessage = vi.fn((file: Blob) => {
          void hashBlob(file).then((digest) => this.reply({ digest }));
        });
      }
    }
    vi.stubGlobal("Worker", TestWorker);
    await expect(sha256(new Blob(["abc"]))).resolves.toBe(ABC_SHA);
    expect(url.pathname).toMatch(/\/hash\.worker\.ts$/);
    expect(options).toEqual({ type: "module" });
  });
});

describe("worker entry point", () => {
  it.each([false, true])("posts the real core's success/failure response (failure=%s)", async (fails) => {
    vi.resetModules();
    const scope = {
      onmessage: null as ((event: MessageEvent<Blob>) => Promise<void>) | null,
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", scope);
    await import("./hash.worker");
    const file = fails
      ? { size: 1, slice: () => { throw new Error("source disconnected"); } } as unknown as Blob
      : new Blob(["abc"]);
    await scope.onmessage!(new MessageEvent("message", { data: file }));
    expect(scope.postMessage).toHaveBeenCalledWith(fails ? { error: "source disconnected" } : { digest: ABC_SHA });
    expect(scope.onmessage).toBeNull();
  });
});
