import { NextResponse, type NextRequest } from "next/server";

// Hostname-based product selection: one deployment serves both products.
// Arrivals on the photos domain (NEXT_PUBLIC_PHOTOS_HOSTNAME) get `/`
// rewritten to `/photos`; the receipts domain behaves exactly as today.
// Both products stay path-reachable from either domain — the hostname only
// decides the default.

/**
 * Pure decision function (unit-tested): given the request host, path, and the
 * configured photos hostname, return the rewrite target or null for no-op.
 */
export function resolvePhotosRewrite(
  host: string | null,
  pathname: string,
  photosHostname: string | undefined
): string | null {
  if (!photosHostname || !host) return null;
  const hostname = host.split(":")[0].toLowerCase();
  if (hostname !== photosHostname.toLowerCase()) return null;
  if (pathname !== "/") return null;
  return "/photos";
}

export function middleware(request: NextRequest) {
  const target = resolvePhotosRewrite(
    request.headers.get("host"),
    request.nextUrl.pathname,
    process.env.NEXT_PUBLIC_PHOTOS_HOSTNAME
  );
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

// Only the root path is ever rewritten; /login, /api, /_next, and static
// assets never enter the middleware at all.
export const config = {
  matcher: ["/"],
};
