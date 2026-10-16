import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "@/lib/local-storage-polyfill";
import "./globals.css";
import { Toaster as SonnerToaster } from "sonner";
import { TOAST_REGION_ID } from "@/lib/toast-region";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DWS Receipts",
  description: "Receipt management application for Design Workshops employees and accounting staff",
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon-16x16.png',
    apple: '/apple-touch-icon.png',
  },
};

// viewportFit + themeColor: mobile Safari paints the status-bar and toolbar
// regions in the app background instead of white (both apps use #222222).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1.0,
  viewportFit: "cover",
  themeColor: "#222222",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} antialiased overflow-hidden`}
      >
        {/*
          No QueryProvider here: each signed-in area's layout mounts it, so the
          public share page does not ship it. The toaster stays: the photo
          viewer exempts it from inert by being a direct <body> child.
        */}
        {children}
        {/*
          One app-wide mount; every surface calls toast(). The wrapper carries
          the id because sonner's own [data-sonner-toaster] sits on an inner
          <ol> that unmounts whenever no toast is up. Layout-neutral — the
          toast list is position: fixed.
        */}
        <div id={TOAST_REGION_ID}>
          <SonnerToaster richColors theme="dark" />
        </div>
      </body>
    </html>
  );
}
