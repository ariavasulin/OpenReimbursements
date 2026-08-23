// Content hashing for dedupe. SHA-256 over the full file via WebCrypto —
// arrayBuffer() of <=100 MB is acceptable on a phone, and WebCrypto has no
// streaming digest, so bigger files simply skip dedupe (null hash).

export const HASH_MAX_BYTES = 100 * 1024 * 1024;

export async function sha256(file: Blob): Promise<string | null> {
  if (file.size > HASH_MAX_BYTES || typeof crypto?.subtle === "undefined") {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
