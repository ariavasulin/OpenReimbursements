import type { Metadata } from "next";
import { Toaster as SonnerToaster } from "sonner";
import { UploadManagerProvider } from "@/lib/photos/upload-manager";
import UploadTray from "@/components/photos/upload-tray";

export const metadata: Metadata = {
  title: "DWS Photos",
  description: "Project photo hub for Design Workshops",
};

// The root layout's <body> is overflow-hidden, so the photos app provides its
// own scroll container — without this, the job list cannot scroll on a phone.
// With viewport-fit=cover the container runs under the notch and home
// indicator, so it pads by the safe-area insets.
//
// The upload manager lives HERE (not in a page) so in-flight uploads survive
// navigating between photos pages; the tray shows their progress everywhere.
export default function PhotosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="h-dvh overflow-y-auto overscroll-contain bg-[#222222] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-white">
      <UploadManagerProvider>
        {children}
        <UploadTray maxWidthClass="max-w-2xl" />
        <SonnerToaster richColors theme="dark" />
      </UploadManagerProvider>
    </div>
  );
}
