import type { Metadata } from "next";
import { Suspense } from "react";
import { preconnect } from "react-dom";
import { QueryProvider } from "@/components/providers/query-provider";
import PhotosShell from "@/components/photos/photos-shell";
import { PageSkeleton } from "@/components/photos/shell-skeleton";
import UploadShell from "@/components/photos/upload-shell";

// Its own icon and manifest, so a home-screen shortcut to the photo library is
// a blue photo tile called "DWS Photos" that opens on Projects, not the
// receipts icon the rest of the site carries.
export const metadata: Metadata = {
  title: "DWS Photos",
  description: "Project photo hub for Design Workshops",
  manifest: "/photos-app/manifest.webmanifest",
  icons: {
    icon: [{ url: "/photos-app/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: "/photos-app/apple-touch-icon.png",
  },
  appleWebApp: { title: "DWS Photos", capable: true, statusBarStyle: "black" },
};

// The upload shell lives HERE (not in a page) so in-flight uploads survive
// navigating between photos pages; the tray shows their progress everywhere.
// PhotosShell sits inside it — it mounts the upload sheet, which hands its
// batch to the manager, and places the tray above its phone tab bar.
//
// /photos/search calls useSearchParams(), so a Suspense boundary is required
// — without it Next refuses to prerender that route. It wraps only the page,
// so the frame (tab bar, top bar) is in the prerendered HTML too.
export default function PhotosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Every thumbnail comes from the Supabase host. Opening that connection now
  // (DNS, TCP, TLS: 2-3 round trips, ~70 ms each from the Bay Area to the east
  // coast) means the first <img> does not pay for it after the API answers.
  // No crossOrigin: images are fetched without CORS, and a CORS preconnect
  // would open a connection they cannot use.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) preconnect(supabaseUrl);
  // The query cache is mounted here, not in the root layout, so the public
  // share page does not ship it.
  return (
    <QueryProvider>
      <UploadShell tray={false}>
        <PhotosShell>
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </PhotosShell>
      </UploadShell>
    </QueryProvider>
  );
}
