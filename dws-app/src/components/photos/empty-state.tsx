"use client";

import type { ReactNode } from "react";

/**
 * An empty screen that says what it is and carries its own next step, instead
 * of a grey line under a row of filters that cannot help.
 */
export default function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  /** One or two plain sentences. */
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-2 py-12 text-center">
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#2e2e2e] text-[#8bbaff]">
          {icon}
        </div>
      )}
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {children && <p className="mt-2 text-base leading-relaxed text-[#b4b4b4]">{children}</p>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

export const emptyPrimary =
  "flex min-h-11 items-center gap-2 rounded-lg bg-[#2680FC] px-4 text-base font-medium text-white hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white";
export const emptySecondary =
  "flex min-h-11 items-center gap-2 rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] px-4 text-base font-medium text-white hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-white";
