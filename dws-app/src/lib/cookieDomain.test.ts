import { describe, expect, it } from "vitest";
import { cookieDomainForHost, isPhotosHost } from "./cookieDomain";

const PHOTOS_HOST = "photos.dws-receipts.com";

describe("isPhotosHost", () => {
  it("matches the photos hostname ignoring port and case", () => {
    expect(isPhotosHost(PHOTOS_HOST, PHOTOS_HOST)).toBe(true);
    expect(isPhotosHost(`${PHOTOS_HOST}:443`, PHOTOS_HOST)).toBe(true);
    expect(isPhotosHost("Photos.DWS-Receipts.com", PHOTOS_HOST)).toBe(true);
  });

  it("matches the same subdomain on the other apex", () => {
    expect(isPhotosHost("photos.design-workshops.app", PHOTOS_HOST)).toBe(true);
    expect(isPhotosHost(PHOTOS_HOST, "photos.design-workshops.app")).toBe(true);
    expect(isPhotosHost("design-workshops.app", PHOTOS_HOST)).toBe(false);
    expect(isPhotosHost("mcp.design-workshops.app", PHOTOS_HOST)).toBe(false);
    expect(isPhotosHost("photos.example.com", PHOTOS_HOST)).toBe(false);
  });

  it("does not spread a bare-apex photos hostname to the other apex", () => {
    expect(isPhotosHost("dws-receipts.com", "dws-receipts.com")).toBe(true);
    expect(isPhotosHost("design-workshops.app", "dws-receipts.com")).toBe(
      false
    );
  });

  it("only matches exactly when the photos hostname is off-apex", () => {
    expect(isPhotosHost("photos.localhost:3000", "photos.localhost")).toBe(true);
    expect(isPhotosHost(PHOTOS_HOST, "photos.localhost")).toBe(false);
  });

  it("is false when the photos hostname is unset or empty", () => {
    expect(isPhotosHost(PHOTOS_HOST, undefined)).toBe(false);
    expect(isPhotosHost(PHOTOS_HOST, "")).toBe(false);
  });

  it("is false for other hosts or a missing host header", () => {
    expect(isPhotosHost("www.dws-receipts.com", PHOTOS_HOST)).toBe(false);
    expect(isPhotosHost("localhost:3000", PHOTOS_HOST)).toBe(false);
    expect(isPhotosHost("dws-receipts-2.vercel.app", PHOTOS_HOST)).toBe(false);
    expect(isPhotosHost(null, PHOTOS_HOST)).toBe(false);
  });
});

describe("cookieDomainForHost", () => {
  it("scopes apex-family hosts to .dws-receipts.com", () => {
    expect(cookieDomainForHost("www.dws-receipts.com")).toBe(
      ".dws-receipts.com"
    );
    expect(cookieDomainForHost("photos.dws-receipts.com")).toBe(
      ".dws-receipts.com"
    );
    expect(cookieDomainForHost("dws-receipts.com")).toBe(".dws-receipts.com");
    expect(cookieDomainForHost("WWW.DWS-Receipts.com:443")).toBe(
      ".dws-receipts.com"
    );
  });

  it("scopes design-workshops.app hosts to .design-workshops.app", () => {
    expect(cookieDomainForHost("design-workshops.app")).toBe(
      ".design-workshops.app"
    );
    expect(cookieDomainForHost("photos.design-workshops.app")).toBe(
      ".design-workshops.app"
    );
  });

  it("sets no domain on other hosts", () => {
    expect(cookieDomainForHost("localhost:3000")).toBeUndefined();
    expect(cookieDomainForHost("dws-receipts-2.vercel.app")).toBeUndefined();
    expect(cookieDomainForHost("evil-dws-receipts.com")).toBeUndefined();
    expect(cookieDomainForHost("evil-design-workshops.app")).toBeUndefined();
    expect(cookieDomainForHost(null)).toBeUndefined();
    expect(cookieDomainForHost(undefined)).toBeUndefined();
  });
});
