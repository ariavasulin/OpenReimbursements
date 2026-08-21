// The auth-cookie domain is only applied when the request host actually
// belongs to the apex — on localhost and *.vercel.app previews a
// `.dws-receipts.com` cookie would be rejected by the browser and break login.

export const AUTH_COOKIE_APEX = "dws-receipts.com";

/** Lower-cased hostname without a port ("Host:443" -> "host"). */
export function normalizeHostname(host: string): string {
  return host.split(":")[0].toLowerCase();
}

/** Is this request host the photos product (NEXT_PUBLIC_PHOTOS_HOSTNAME)? */
export function isPhotosHost(
  host: string | null | undefined,
  photosHostname: string | undefined = process.env.NEXT_PUBLIC_PHOTOS_HOSTNAME
): boolean {
  if (!photosHostname || !host) return false;
  return normalizeHostname(host) === normalizeHostname(photosHostname);
}

export function cookieDomainForHost(
  host: string | null | undefined
): string | undefined {
  if (!host) return undefined;
  const hostname = normalizeHostname(host);
  if (
    hostname === AUTH_COOKIE_APEX ||
    hostname.endsWith(`.${AUTH_COOKIE_APEX}`)
  ) {
    return `.${AUTH_COOKIE_APEX}`;
  }
  return undefined;
}
