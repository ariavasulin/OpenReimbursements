"use client";

import { Toaster as SonnerToaster } from "sonner";
import { UploadManagerProvider } from "@/lib/photos/upload-manager";
import UploadTray from "@/components/photos/upload-tray";

// Everything an upload surface needs around its content: the manager that owns
// the queue, the tray that reports it, and the toaster both talk through.

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
      <SonnerToaster richColors theme="dark" />
    </UploadManagerProvider>
  );
}
