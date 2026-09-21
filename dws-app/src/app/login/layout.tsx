import type { Metadata } from "next";
import { headers } from "next/headers";
import { isPhotosHost } from "@/lib/cookieDomain";

// The sign-in page is shared by both products. On the photos address the
// browser tab says DWS Photos from the first byte; the page itself also sets it
// when the person is headed to a photos page from some other address.
export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host");
  return isPhotosHost(host) ? { title: "DWS Photos" } : {};
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
