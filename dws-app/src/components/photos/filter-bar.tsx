"use client";

import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FilterOption } from "@/lib/photos/filter-options";

/** 44px tall: these are everyday controls for people on phones in the field. */
export const chipClass = (active: boolean) =>
  `flex min-h-11 items-center rounded-full border px-4 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] focus-visible:ring-offset-2 focus-visible:ring-offset-[#222222] ${
    active
      ? "border-[#2680FC] bg-[#2680FC] font-medium text-white"
      : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0] hover:border-[#6e6e6e]"
  }`;

/**
 * One dropdown filter chip. It renders nothing when there is nothing to choose
 * and nothing chosen: a menu that only says "None yet" cannot help anyone.
 */
export function FilterChip({
  label,
  active,
  options,
  onSelect,
  onClear,
}: {
  label: string;
  active: string | null;
  options: FilterOption[];
  onSelect(value: string): void;
  onClear(): void;
}) {
  if (options.length === 0 && !active) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // Spelled out: "Tag" alone is also a Group by button on the same screen.
          aria-label={active ? `${label}: ${active}` : `Filter by ${label.toLowerCase()}`}
          className={`max-w-full gap-1.5 ${chipClass(Boolean(active))}`}
        >
          <span className="min-w-0 truncate">{active ?? label}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60dvh] max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto border-[#4e4e4e] bg-[#2e2e2e] p-1 text-white"
      >
        {active && (
          <DropdownMenuItem
            onClick={onClear}
            className="min-h-11 px-3 text-base text-[#8bbaff] focus:bg-[#3e3e3e] focus:text-white"
          >
            Show every {label.toLowerCase()}
          </DropdownMenuItem>
        )}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className="min-h-11 whitespace-normal break-words px-3 text-base focus:bg-[#3e3e3e] focus:text-white"
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
