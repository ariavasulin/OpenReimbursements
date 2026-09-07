import { classifyFile, type PickKind } from "../classify";
import { abortUploadWork } from "../upload-http";

export const MAX_INVENTORY_ENTRIES = 500;
export const MAX_INVENTORY_BYTES = 1024 * 1024;

/** Structural subset of the browser handles, also usable by directory fixtures. */
export interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}
export interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileHandle | DirectoryHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
}
export interface SourceMetadata {
  relative_path: string;
  original_name: string;
  original_bytes: number;
  source_mtime: number;
  mime_type: string;
  source_signature: string;
}
export interface InventoryEntry extends SourceMetadata {
  sidecar?: SourceMetadata;
  status?: "pending" | "skipped_unsupported";
  warnings?: string[];
}
export interface LocalSource {
  kind: "directory" | "files";
  label: string;
  entries(signal?: AbortSignal): AsyncIterable<InventoryEntry>;
  getFile(relativePath: string, signal?: AbortSignal): Promise<File>;
}

function assertPath(path: string): string[] {
  const segments = path.split("/");
  if (!path || segments.some((part) => !part || part === "." || part === ".." || /[\\\u0000:]/.test(part))) {
    throw new Error("Select a valid source-relative file path.");
  }
  return segments;
}

function exclusion(path: string): string | undefined {
  const parts = path.toLowerCase().split("/");
  if (parts.includes(".picasaoriginals")) return "picasa_originals";
  if (parts.at(-1) === ".picasa.ini") return "picasa_settings";
  if (parts.some((part) => part.startsWith(".") || ["__macosx", "$recycle.bin", "thumbs.db", "desktop.ini"].includes(part))) {
    return "hidden_cache";
  }
}

type Candidate = { entry: InventoryEntry; kind: PickKind };
function metadata(file: File, relativePath: string): Candidate {
  assertPath(relativePath);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.lastModified)) {
    throw new Error("Source file metadata exceeds supported integer bounds.");
  }
  const { kind, mime } = classifyFile(file);
  const reason = exclusion(relativePath);
  return {
    kind,
    entry: {
      relative_path: relativePath,
      original_name: file.name,
      original_bytes: file.size,
      source_mtime: file.lastModified,
      mime_type: mime,
      source_signature: JSON.stringify([file.name, file.size, file.lastModified, mime]),
      status: reason ? "skipped_unsupported" : "pending",
      ...(reason ? { warnings: [reason] } : {}),
    },
  };
}

function basename(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot > path.lastIndexOf("/") + 1 ? path.slice(0, dot) : path).toLowerCase();
}

/** Contains metadata only: neither file handles, File objects nor byte buffers. */
function* pairedEntries(candidates: Candidate[]): Generator<InventoryEntry> {
  const pairs = new Map<string, { images: Candidate[]; sidecars: Candidate[] }>();
  for (const candidate of candidates) {
    if (candidate.entry.status === "skipped_unsupported" || !["image", "sidecar"].includes(candidate.kind)) continue;
    const key = basename(candidate.entry.relative_path);
    const group = pairs.get(key) ?? { images: [], sidecars: [] };
    group[candidate.kind === "image" ? "images" : "sidecars"].push(candidate);
    pairs.set(key, group);
  }
  const attached = new Set<Candidate>();
  for (const { images, sidecars } of pairs.values()) {
    if (images.length === 1 && sidecars.length === 1) {
      const { status: _status, warnings: _warnings, ...descriptor } = sidecars[0].entry;
      images[0].entry.sidecar = descriptor;
      attached.add(sidecars[0]);
    } else if (images.length > 0 && sidecars.length > 0) {
      for (const candidate of [...images, ...sidecars]) candidate.entry.warnings = ["ambiguous_xmp"];
    }
  }
  candidates.sort((a, b) => a.entry.relative_path < b.entry.relative_path ? -1 : a.entry.relative_path > b.entry.relative_path ? 1 : 0);
  for (const candidate of candidates) {
    if (attached.has(candidate)) continue;
    const { entry, kind } = candidate;
    if (entry.status !== "skipped_unsupported" && (kind === "file" || kind === "sidecar")) {
      entry.status = "skipped_unsupported";
      entry.warnings = [...(entry.warnings ?? []), kind === "sidecar" ? "unmatched_xmp" : "unsupported_file"];
    }
    yield entry;
  }
}

async function* scanDirectory(root: DirectoryHandle, prefix: string, signal?: AbortSignal): AsyncGenerator<InventoryEntry> {
  signal?.throwIfAborted();
  const candidates: Candidate[] = [];
  const directories: string[] = [];
  const iterator = root.values()[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    while (true) {
      const next = await abortUploadWork(() => iterator.next(), signal);
      if (next.done) {
        exhausted = true;
        break;
      }
      const handle = next.value;
      const path = prefix + handle.name;
      assertPath(path);
      if (handle.kind === "directory") directories.push(handle.name);
      else candidates.push(metadata(await abortUploadWork(() => handle.getFile(), signal), path));
    }
  } finally {
    // Native directory operations cannot themselves be cancelled. Request
    // iterator cleanup without letting a disconnected drive block cancellation.
    if (!exhausted) void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
  }
  for (const entry of pairedEntries(candidates)) {
    signal?.throwIfAborted();
    yield entry;
  }
  // Release this directory's metadata before descending; only directory names
  // remain on the recursion stack. Excluded files still count in the ledger.
  candidates.length = 0;
  for (const name of directories.sort()) {
    signal?.throwIfAborted();
    yield* scanDirectory(await abortUploadWork(() => root.getDirectoryHandle(name), signal), prefix + name + "/", signal);
  }
}

export function directorySource(root: DirectoryHandle): LocalSource {
  return {
    kind: "directory",
    label: root.name,
    entries: (signal) => scanDirectory(root, "", signal),
    async getFile(relativePath, signal) {
      const parts = assertPath(relativePath);
      let directory = root;
      for (const part of parts.slice(0, -1)) directory = await abortUploadWork(() => directory.getDirectoryHandle(part), signal);
      const handle = await abortUploadWork(() => directory.getFileHandle(parts.at(-1)!), signal);
      return abortUploadWork(() => handle.getFile(), signal);
    },
  };
}

/** File inputs are deliberately compact; large selections use directory handles. */
export function filesSource(files: ArrayLike<File>, label = "Selected files"): LocalSource {
  if (files.length > MAX_INVENTORY_ENTRIES) throw new Error("Select up to 500 files, or select a folder for a larger migration.");
  const selected = new Map<string, File>();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    assertPath(file.name);
    if (selected.has(file.name)) throw new Error("Files with the same name must be selected as separate folder sources.");
    selected.set(file.name, file);
  }
  return {
    kind: "files",
    label,
    async *entries(signal) {
      const candidates: Candidate[] = [];
      for (const file of selected.values()) {
        signal?.throwIfAborted();
        candidates.push(metadata(file, file.name));
      }
      for (const entry of pairedEntries(candidates)) {
        signal?.throwIfAborted();
        yield entry;
      }
    },
    async getFile(relativePath, signal) {
      signal?.throwIfAborted();
      assertPath(relativePath);
      const file = selected.get(relativePath);
      if (!file) throw new DOMException("Reselect the missing source file.", "NotFoundError");
      return file;
    },
  };
}

/** Reserve 1 KiB for scan UUID/ordinal and the request envelope by default.
 * An envelope builder must wrap the entries array once without transforming it.
 * Backpressure holds only one chunk plus the next metadata entry.
 */
export async function* inventoryChunks(
  entries: AsyncIterable<InventoryEntry> | Iterable<InventoryEntry>,
  envelope?: (entries: InventoryEntry[], chunkNumber: number) => unknown,
): AsyncGenerator<InventoryEntry[]> {
  const encoder = new TextEncoder();
  let chunk: InventoryEntry[] = [];
  let chunkNumber = 0;
  let entriesBytes = 2;
  const overhead = () => envelope
    ? encoder.encode(JSON.stringify(envelope([], chunkNumber))).byteLength - 2
    : 1024;
  let envelopeBytes = overhead();
  const verify = () => {
    if (envelope && encoder.encode(JSON.stringify(envelope(chunk, chunkNumber))).byteLength > MAX_INVENTORY_BYTES) {
      throw new Error("Inventory envelope exceeds the 1 MiB request limit.");
    }
  };
  for await (const entry of entries) {
    const bytes = encoder.encode(JSON.stringify(entry)).byteLength;
    const nextBytes = entriesBytes + bytes + (chunk.length ? 1 : 0);
    if (chunk.length && (chunk.length === MAX_INVENTORY_ENTRIES || nextBytes + envelopeBytes > MAX_INVENTORY_BYTES)) {
      verify();
      yield chunk;
      chunk = [];
      entriesBytes = 2;
      chunkNumber++;
      envelopeBytes = overhead();
    }
    const newBytes = entriesBytes + bytes + (chunk.length ? 1 : 0);
    if (newBytes + envelopeBytes > MAX_INVENTORY_BYTES) throw new Error("One inventory entry exceeds the 1 MiB request limit.");
    chunk.push(entry);
    entriesBytes = newBytes;
  }
  if (chunk.length) {
    verify();
    yield chunk;
  }
}
