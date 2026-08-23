import type { Metadata } from "next";
import { Suspense } from "react";
import {
  AuthLoading,
  PHOTOS_AUTH_LOADING_CLASS,
} from "@/hooks/use-session-guard";
import PhotosShell from "@/components/photos/photos-shell";
import UploadShell from "@/components/photos/upload-shell";

export const metadata: Metadata = {
  title: "DWS Photos",
  description: "Project photo hub for Design Workshops",
};

// The upload shell lives HERE (not in a page) so in-flight uploads survive
// navigating between photos pages; the tray shows their progress everywhere.
// PhotosShell sits inside it — it mounts the upload sheet, which hands its
// batch to the manager — and owns the scroll container and the desktop frame.
//
// PhotosShell calls useSearchParams(), so the Suspense boundary is required —
// without it Next refuses to prerender /photos and /photos/search.
export default function PhotosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <Suspense
      fallback={
        <AuthLoading className={PHOTOS_AUTH_LOADING_CLASS} />
      }
    >
      <UploadShell>
        <PhotosShell>{children}</PhotosShell>
      </UploadShell>
    </Suspense>
  );
}
