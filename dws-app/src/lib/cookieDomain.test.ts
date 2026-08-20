import { describe, expect, it } from "vitest";
import { cookieDomainForHost } from "./cookieDomain";

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

  it("sets no domain on other hosts", () => {
    expect(cookieDomainForHost("localhost:3000")).toBeUndefined();
    expect(cookieDomainForHost("dws-receipts-2.vercel.app")).toBeUndefined();
    expect(cookieDomainForHost("evil-dws-receipts.com")).toBeUndefined();
    expect(cookieDomainForHost(null)).toBeUndefined();
    expect(cookieDomainForHost(undefined)).toBeUndefined();
  });
});
