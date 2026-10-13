import { NextResponse, type NextRequest } from "next/server";
import { isPhotosHost } from "./lib/cookieDomain";

// photos host: / -> /photos/projects (the app starts on Projects); everything
// else untouched (matcher is "/" only).

export function middleware(request: NextRequest) {
  if (
    isPhotosHost(
      request.headers.get("host"),
      process.env.NEXT_PUBLIC_PHOTOS_HOSTNAME
    ) &&
    request.nextUrl.pathname === "/"
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/photos/projects";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
