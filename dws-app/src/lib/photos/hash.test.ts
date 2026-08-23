import { describe, expect, it, vi } from "vitest";
import { HASH_MAX_BYTES, sha256 } from "./hash";

describe("sha256", () => {
  it("hashes bytes to lowercase hex (known vector)", async () => {
    await expect(sha256(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("returns null over the cap WITHOUT reading the bytes", async () => {
    const arrayBuffer = vi.fn();
    const tooBig = { size: HASH_MAX_BYTES + 1, arrayBuffer } as unknown as Blob;

    await expect(sha256(tooBig)).resolves.toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("still hashes a file exactly at the cap boundary", async () => {
    const atCap = {
      size: HASH_MAX_BYTES,
      arrayBuffer: async () => new TextEncoder().encode("abc").buffer,
    } as unknown as Blob;

    await expect(sha256(atCap)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
