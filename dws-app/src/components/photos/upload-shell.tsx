"use client";

import { UploadManagerProvider } from "@/lib/photos/upload-manager";
import UploadTray from "@/components/photos/upload-tray";

// Everything an upload surface needs around its content: the manager that owns
// the queue and the tray that reports it. The toaster they both talk through is
// mounted once app-wide in app/layout.tsx.

export default function UploadShell({
  children,
  maxWidthClass = "max-w-3xl",
}: {
  children: React.ReactNode;
  /** Tailwind max-width class matching the page's <main>. */
  maxWidthClass?: string;
}) {
  return (
    <UploadManagerProvider>
      {children}
      <UploadTray maxWidthClass={maxWidthClass} />
    </UploadManagerProvider>
  );
}
