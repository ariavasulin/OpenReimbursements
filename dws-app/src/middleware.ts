import { NextResponse, type NextRequest } from "next/server";
import { isPhotosHost } from "./lib/cookieDomain";

// Hostname-based product selection: one deployment serves both products. The
// hostname only decides the default; both products stay path-reachable.

/** Return the rewrite target for this request, or null for no-op. */
export function resolvePhotosRewrite(
  host: string | null,
  pathname: string,
  photosHostname: string | undefined
): string | null {
  if (!isPhotosHost(host, photosHostname) || pathname !== "/") return null;
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

export const config = {
  matcher: ["/"],
};
