import { createSHA256 } from "hash-wasm";
import type { HashOptions } from "./hash";

export const HASH_CHUNK_BYTES = 6 * 1024 * 1024;

/** A hasher left free by the last file: building one compiles WebAssembly, so a long-lived worker keeps it. */
let spare: Awaited<ReturnType<typeof createSHA256>> | null = null;

/** Worker-only byte processing: one bounded read at a time for every file size. */
export async function hashBlob(file: Blob, { signal }: HashOptions = {}): Promise<string> {
  signal?.throwIfAborted();
  const hasher = spare ?? await createSHA256();
  spare = null;
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const end = Math.min(offset + HASH_CHUNK_BYTES, file.size);
    const bytes = await file.slice(offset, end).arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== end - offset) throw new Error("Hash source read was incomplete");
    hasher.update(new Uint8Array(bytes));
  }
  signal?.throwIfAborted();
  const digest = hasher.digest("hex");
  // Only a hasher that finished cleanly is reused; init() resets it for the next file.
  spare = hasher;
  return digest;
}
