"use client";

import { UploadManagerProvider } from "@/lib/photos/upload-manager";
import UploadTray, { TRAY_FIXED_CLASS } from "@/components/photos/upload-tray";

// Everything an upload surface needs around its content: the manager that owns
// the queue and the tray that reports it.

export default function UploadShell({
  children,
  tray = true,
}: {
  children: React.ReactNode;
  /** false when the content places the tray itself (the photos shell does,
   *  above its phone tab bar). */
  tray?: boolean;
}) {
  return (
    <UploadManagerProvider>
      {children}
      {tray && <UploadTray className={TRAY_FIXED_CLASS} />}
    </UploadManagerProvider>
  );
}
