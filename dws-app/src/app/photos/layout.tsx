import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DWS Photos",
  description: "Project photo hub for Design Workshops",
};

// The root layout's <body> is overflow-hidden, so the photos app provides its
// own scroll container — without this, the job list cannot scroll on a phone.
export default function PhotosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="h-dvh overflow-y-auto overscroll-contain bg-[#222222] text-white">
      {children}
    </div>
  );
}
