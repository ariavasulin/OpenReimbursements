import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DWS Photos",
  description: "Project photo hub for Design Workshops",
};

// The root layout's <body> is overflow-hidden, so the photos app provides its
// own scroll container — without this, the job list cannot scroll on a phone.
// With viewport-fit=cover the container runs under the notch and home
// indicator, so it pads by the safe-area insets.
export default function PhotosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="h-dvh overflow-y-auto overscroll-contain bg-[#222222] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-white">
      {children}
    </div>
  );
}
