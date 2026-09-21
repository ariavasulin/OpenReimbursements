"use client";

import type { GroupBy } from "@/lib/photos/group";

const MODE_LABEL: Record<GroupBy, string> = {
  date: "Date",
  tag: "Tag",
  job: "Project",
};

/**
 * Segmented control picking how the grid groups, with its name in front of it:
 * two unlabeled words ("Date", "Tag") beside the filters read as two more
 * filters.
 */
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
    <div
      role="group"
      aria-label="Group by"
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="text-sm text-[#b4b4b4]">Group by</span>
      <div className="flex overflow-hidden rounded-full border border-[#4e4e4e] bg-[#2e2e2e]">
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}
            className={`min-h-11 px-5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2680FC] ${
              value === mode
                ? "bg-[#4a4a4a] font-semibold text-white"
                : "text-[#b4b4b4] hover:text-white"
            }`}
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}
