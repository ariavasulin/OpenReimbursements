import { createSHA256 } from "hash-wasm";
import type { HashOptions } from "./hash";

export const HASH_CHUNK_BYTES = 6 * 1024 * 1024;

/** Worker-only byte processing: one bounded read at a time for every file size. */
export async function hashBlob(file: Blob, { signal }: HashOptions = {}): Promise<string> {
  signal?.throwIfAborted();
  const hasher = await createSHA256();
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
  return hasher.digest("hex");
}
