"use client";

import type { ReactNode } from "react";

/** Centered loading / empty (muted) or error (red) line under a list. */
export default function StatusLine({
  error = false,
  children,
}: {
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={`py-8 text-center text-sm ${error ? "text-red-400" : "text-[#a0a0a0]"}`}
    >
      {children}
    </p>
  );
}
