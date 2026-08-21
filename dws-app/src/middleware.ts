import { NextResponse, type NextRequest } from "next/server";
import { isPhotosHost } from "./lib/cookieDomain";

// photos host: / -> /photos; everything else untouched (matcher is "/" only).

export function middleware(request: NextRequest) {
  if (
    isPhotosHost(
      request.headers.get("host"),
      process.env.NEXT_PUBLIC_PHOTOS_HOSTNAME
    ) &&
    request.nextUrl.pathname === "/"
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/photos";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
