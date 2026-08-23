"use client";

import type { GroupBy } from "@/lib/photos/group";

/** Segmented control picking how the grid groups (date / sheet / job). */
export default function GroupByToggle<T extends GroupBy>({
  modes,
  value,
  onChange,
}: {
  modes: readonly T[];
  value: T;
  onChange(mode: T): void;
}) {
  return (
    <div className="mb-1 flex overflow-hidden rounded-lg border border-[#4e4e4e] bg-[#2e2e2e]">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`flex-1 px-4 py-1.5 text-xs capitalize ${
            value === mode
              ? "bg-[#3e3e3e] font-semibold text-white"
              : "text-[#a0a0a0]"
          }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
