// The auth-cookie domain is only applied when the request host actually
// belongs to one of the apexes — on localhost and *.vercel.app previews a
// `.dws-receipts.com` cookie would be rejected by the browser and break login.

export const AUTH_COOKIE_APEXES = [
  "dws-receipts.com",
  "design-workshops.app",
] as const;

// Replaces the Supabase default name (`sb-<project ref>-auth-token`). Browsers
// that logged in before the cookie became apex-scoped still hold a host-only
// cookie under the default name; it is sent alongside the apex-scoped one, the
// server can read its long-dead refresh token instead of the current one, and
// every refresh fails with "Failed to get session". A name those browsers
// never stored sidesteps it. Changing the cookie's domain scoping again needs
// another new name.
export const AUTH_COOKIE_NAME = "dws-auth";

/** Lower-cased hostname without a port ("Host:443" -> "host"). */
export function normalizeHostname(host: string): string {
  return host.split(":")[0].toLowerCase();
}

function apexForHostname(hostname: string): string | undefined {
  return AUTH_COOKIE_APEXES.find(
    (apex) => hostname === apex || hostname.endsWith(`.${apex}`)
  );
}

/**
 * Is this request host the photos product? NEXT_PUBLIC_PHOTOS_HOSTNAME names
 * it on one apex; the same subdomain on the other apexes counts too.
 */
export function isPhotosHost(
  host: string | null | undefined,
  photosHostname: string | undefined = process.env.NEXT_PUBLIC_PHOTOS_HOSTNAME
): boolean {
  if (!photosHostname || !host) return false;
  const hostname = normalizeHostname(host);
  const photos = normalizeHostname(photosHostname);
  if (hostname === photos) return true;
  const photosApex = apexForHostname(photos);
  if (!photosApex) return false;
  const subdomain = photos.slice(0, photos.length - photosApex.length);
  if (!subdomain) return false;
  return AUTH_COOKIE_APEXES.some((apex) => hostname === `${subdomain}${apex}`);
}

export function cookieDomainForHost(
  host: string | null | undefined
): string | undefined {
  if (!host) return undefined;
  const apex = apexForHostname(normalizeHostname(host));
  return apex ? `.${apex}` : undefined;
}
