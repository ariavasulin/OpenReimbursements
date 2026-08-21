import { describe, expect, it } from "vitest";
import { resolvePhotosRewrite } from "./middleware";

const PHOTOS_HOST = "photos.dws-receipts.com";

describe("resolvePhotosRewrite", () => {
  it("rewrites / to /photos on the photos host", () => {
    expect(resolvePhotosRewrite(PHOTOS_HOST, "/", PHOTOS_HOST)).toBe("/photos");
  });

  it("ignores the port when matching the host", () => {
    expect(resolvePhotosRewrite(`${PHOTOS_HOST}:443`, "/", PHOTOS_HOST)).toBe(
      "/photos"
    );
  });

  it("matches the host case-insensitively", () => {
    expect(
      resolvePhotosRewrite("Photos.DWS-Receipts.com", "/", PHOTOS_HOST)
    ).toBe("/photos");
  });

  it("does not rewrite / on the receipts host", () => {
    expect(
      resolvePhotosRewrite("www.dws-receipts.com", "/", PHOTOS_HOST)
    ).toBeNull();
  });

  it("does not rewrite / on localhost or previews", () => {
    expect(resolvePhotosRewrite("localhost:3000", "/", PHOTOS_HOST)).toBeNull();
    expect(
      resolvePhotosRewrite("dws-receipts-2.vercel.app", "/", PHOTOS_HOST)
    ).toBeNull();
  });

  it("passes non-root paths through on the photos host", () => {
    for (const path of ["/login", "/api/photos", "/employee", "/photos"]) {
      expect(resolvePhotosRewrite(PHOTOS_HOST, path, PHOTOS_HOST)).toBeNull();
    }
  });

  it("is a no-op when NEXT_PUBLIC_PHOTOS_HOSTNAME is unset", () => {
    expect(resolvePhotosRewrite(PHOTOS_HOST, "/", undefined)).toBeNull();
    expect(resolvePhotosRewrite(PHOTOS_HOST, "/", "")).toBeNull();
  });

  it("is a no-op when the host header is missing", () => {
    expect(resolvePhotosRewrite(null, "/", PHOTOS_HOST)).toBeNull();
  });
});
