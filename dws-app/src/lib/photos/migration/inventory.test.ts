import { describe, expect, it, vi } from "vitest";
import {
  directorySource, filesSource, inventoryChunks, MAX_INVENTORY_BYTES,
  type DirectoryHandle, type FileHandle, type InventoryEntry,
} from "./inventory";

function fileHandle(name: string, size = 7, type = "", mtime = 123): FileHandle {
  return {
    name, kind: "file",
    async getFile() {
      // A metadata-only fixture: attempting any byte access fails the test.
      return {
        name, size, type, lastModified: mtime,
        arrayBuffer() { throw new Error("Inventory read bytes"); },
        slice() { throw new Error("Inventory materialized bytes"); },
        stream() { throw new Error("Inventory streamed bytes"); },
      } as unknown as File;
    },
  };
}

function directory(name: string, children: (FileHandle | DirectoryHandle)[]): DirectoryHandle {
  return {
    name, kind: "directory",
    async *values() { yield* children; },
    async getDirectoryHandle(name) {
      const child = children.find((item) => item.kind === "directory" && item.name === name);
      if (!child) throw new DOMException("Missing directory", "NotFoundError");
      return child as DirectoryHandle;
    },
    async getFileHandle(name) {
      const child = children.find((item) => item.kind === "file" && item.name === name);
      if (!child) throw new DOMException("Missing file", "NotFoundError");
      return child as FileHandle;
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

function entry(name = "a.jpg"): InventoryEntry {
  return {
    relative_path: name, original_name: name, original_bytes: 2_000_000,
    source_mtime: 123, mime_type: "image/jpeg", source_signature: name,
  };
}

describe("source inventory", () => {
  it("keeps identically named source files independent and resolves only the requested file", async () => {
    const firstHandle = fileHandle("a.jpg", 7);
    const secondHandle = fileHandle("a.jpg", 11);
    const firstRead = vi.spyOn(firstHandle, "getFile");
    const first = directorySource(directory("J-123", [directory("site", [firstHandle])]));
    const second = directorySource(directory("J-456", [directory("site", [secondHandle])]));
    expect(await collect(first.entries())).toMatchObject([{ relative_path: "site/a.jpg", original_bytes: 7 }]);
    expect(await collect(second.entries())).toMatchObject([{ relative_path: "site/a.jpg", original_bytes: 11 }]);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect((await first.getFile("site/a.jpg")).size).toBe(7);
    expect(firstRead).toHaveBeenCalledTimes(2);
    await expect(first.getFile("site/missing.jpg")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(first.getFile("../secret.jpg")).rejects.toThrow("source-relative");
  });

  it("pairs case-insensitive same-directory image basenames and leaves other-directory XMP excluded", async () => {
    const source = directorySource(directory("root", [
      fileHandle("PHOTO.JPG"), fileHandle("photo.XmP", 3),
      directory("other", [fileHandle("photo.xmp")]),
    ]));
    const entries = await collect(source.entries());
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      relative_path: "PHOTO.JPG", status: "pending", mime_type: "image/jpeg",
      sidecar: { relative_path: "photo.XmP", original_bytes: 3, mime_type: "application/rdf+xml" },
    });
    expect(entries[0].sidecar).not.toHaveProperty("status");
    expect(entries[1]).toMatchObject({ relative_path: "other/photo.xmp", status: "skipped_unsupported", warnings: ["unmatched_xmp"] });
  });

  it("warns on ambiguous image or sidecar pairs without arbitrarily attaching either", async () => {
    for (const names of [["a.jpg", "a.png", "A.xmp"], ["a.jpg", "a.xmp", "A.XMP"]]) {
      const entries = await collect(directorySource(directory("root", names.map((name) => fileHandle(name)))).entries());
      expect(entries).toHaveLength(3);
      expect(entries.every((item) => !item.sidecar && item.warnings?.includes("ambiguous_xmp"))).toBe(true);
      expect(entries.filter((item) => item.mime_type === "application/rdf+xml").every((item) => item.status === "skipped_unsupported")).toBe(true);
    }
  });

  it("counts Picasa, hidden/cache, unknown files and unmatched XMP with exclusion reasons", async () => {
    const entries = await collect(directorySource(directory("root", [
      fileHandle(".picasa.ini"),
      directory(".picasaoriginals", [directory("nested", [fileHandle("a.jpg")])]),
      directory(".cache", [fileHandle("b.png")]), fileHandle("Thumbs.db"),
      fileHandle("notes.txt"), fileHandle("orphan.xmp"), fileHandle("good.mp4"),
    ])).entries());
    expect(entries).toHaveLength(7);
    expect(entries.filter((item) => item.status === "pending").map((item) => item.original_name)).toEqual(["good.mp4"]);
    expect(entries.flatMap((item) => item.warnings ?? []).sort()).toEqual([
      "hidden_cache", "hidden_cache", "picasa_originals", "picasa_settings", "unmatched_xmp", "unsupported_file",
    ]);
  });

  it("fresh scans see new, removed and changed source metadata without reusing stale File objects", async () => {
    const children: FileHandle[] = [fileHandle("a.jpg")];
    const source = directorySource(directory("root", children));
    const before = await collect(source.entries());
    children.splice(0, 1, fileHandle("a.jpg", 9, "", 456), fileHandle("new.jpg"));
    const after = await collect(source.entries());
    expect(after).toHaveLength(2);
    expect(after[0].source_signature).not.toBe(before[0].source_signature);
    children.splice(0, 1);
    expect((await collect(source.entries())).map((item) => item.relative_path)).toEqual(["new.jpg"]);
    await expect(source.getFile("a.jpg")).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("honors permission loss and scan cancellation", async () => {
    const handle = directory("root", []);
    handle.values = async function* () { throw new DOMException("Select the folder again", "NotAllowedError"); };
    await expect(collect(directorySource(handle).entries())).rejects.toMatchObject({ name: "NotAllowedError" });
    const controller = new AbortController();
    controller.abort();
    await expect(collect(directorySource(directory("root", [fileHandle("a.jpg")])).entries(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["iterator", "metadata", "directory"])("cancels a scan while native %s access hangs after a drive disconnect", async (operation) => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const hang = <T,>(): Promise<T> => {
      started();
      return new Promise<T>(() => {});
    };
    const file = fileHandle("a.jpg");
    const root = directory("root", [file]);
    if (operation === "iterator") root.values = async function* () { await hang(); };
    if (operation === "metadata") file.getFile = () => hang<File>();
    if (operation === "directory") {
      root.values = async function* () { yield directory("nested", [file]); };
      root.getDirectoryHandle = () => hang<DirectoryHandle>();
    }
    const controller = new AbortController();
    const pending = collect(directorySource(root).entries(controller.signal));
    await inFlight;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["directory", "handle", "file"])("cancels lazy file resolution while native %s access hangs", async (operation) => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const hang = <T,>(): Promise<T> => {
      started();
      return new Promise<T>(() => {});
    };
    const file = fileHandle("a.jpg");
    const nested = directory("nested", [file]);
    const root = directory("root", [nested]);
    if (operation === "directory") root.getDirectoryHandle = () => hang<DirectoryHandle>();
    if (operation === "handle") nested.getFileHandle = () => hang<FileHandle>();
    if (operation === "file") file.getFile = () => hang<File>();
    const controller = new AbortController();
    const pending = directorySource(root).getFile("nested/a.jpg", controller.signal);
    await inFlight;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the same pairing for compact selection and bounds retained selected files", async () => {
    const original = new File(["a"], "a.jpg");
    const source = filesSource([original, new File(["xmp"], "a.xmp")]);
    expect(await collect(source.entries())).toMatchObject([{ original_name: "a.jpg", sidecar: { original_name: "a.xmp" } }]);
    expect(await source.getFile("a.jpg")).toBe(original);
    await expect(source.getFile("gone.jpg")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(() => filesSource([original, original])).toThrow("same name");
    expect(() => filesSource({ length: 501 })).toThrow("500 files");
  });

  it("accepts exactly 500 selected files and rejects 501", async () => {
    const files = Array.from({ length: 500 }, (_, index) => new File(["a"], `${index}.jpg`));
    expect(await collect(filesSource(files).entries())).toHaveLength(500);
    files.push(new File(["b"], "501.jpg"));
    expect(() => filesSource(files)).toThrow("500 files");
  });
});

describe("bounded inventory chunks", () => {
  const envelope = (entries: InventoryEntry[], chunk_number: number) => ({ scan_id: "11111111-1111-4111-8111-111111111111", chunk_number, entries });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  it("splits 501 entries into 500 and 1 with pull-based backpressure", async () => {
    let pulled = 0;
    function* entries() {
      for (let index = 0; index < 501; index++) { pulled++; yield entry(String(index)); }
    }
    const chunks = inventoryChunks(entries(), envelope);
    expect((await chunks.next()).value).toHaveLength(500);
    expect(pulled).toBe(501);
    expect((await chunks.next()).value).toHaveLength(1);
    expect((await chunks.next()).done).toBe(true);
  });

  it("accepts an exact 1 MiB UTF-8 envelope and rejects one byte above it", async () => {
    const item = entry("é.jpg");
    item.warnings = [""];
    item.warnings[0] = "x".repeat(MAX_INVENTORY_BYTES - bytes(envelope([item], 0)));
    expect(bytes(envelope([item], 0))).toBe(MAX_INVENTORY_BYTES);
    expect(await collect(inventoryChunks([item], envelope))).toHaveLength(1);
    item.warnings[0] += "x";
    await expect(collect(inventoryChunks([item], envelope))).rejects.toThrow("1 MiB");
  });

  it("splits on encoded-byte bounds before reaching the count bound", async () => {
    const item = entry("照片.jpg");
    item.warnings = ["é".repeat(180_000)];
    const chunks = await collect(inventoryChunks([item, item, item], envelope));
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 1]);
    chunks.forEach((chunk, index) => expect(bytes(envelope(chunk, index))).toBeLessThanOrEqual(MAX_INVENTORY_BYTES));
  });

  it("scans 100,000 metadata-only files totaling 200 GB with bounded requests and no byte reads", async () => {
    const root: DirectoryHandle = {
      ...directory("large", []),
      async *values() {
        for (let index = 0; index < 100_000; index++) yield fileHandle(`${index.toString().padStart(6, "0")}.jpg`, 2_000_000);
      },
    };
    let count = 0;
    let totalBytes = 0;
    let requests = 0;
    for await (const chunk of inventoryChunks(directorySource(root).entries(), envelope)) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(bytes(envelope(chunk, requests))).toBeLessThanOrEqual(MAX_INVENTORY_BYTES);
      count += chunk.length;
      totalBytes += chunk.reduce((sum, item) => sum + item.original_bytes, 0);
      requests++;
    }
    expect(count).toBe(100_000);
    expect(totalBytes).toBe(200_000_000_000);
    expect(requests).toBe(200);
  }, 30_000);
});
