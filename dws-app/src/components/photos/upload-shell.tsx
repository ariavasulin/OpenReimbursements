"use client";

import { UploadManagerProvider } from "@/lib/photos/upload-manager";
import UploadTray from "@/components/photos/upload-tray";

// Everything an upload surface needs around its content: the manager that owns
// the queue and the tray that reports it.

/** Tailwind max-width class matching the page's <main>. */
const TRAY_MAX_WIDTH = "max-w-3xl";

export default function UploadShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <UploadManagerProvider>
      {children}
      <UploadTray maxWidthClass={TRAY_MAX_WIDTH} />
    </UploadManagerProvider>
  );
}
