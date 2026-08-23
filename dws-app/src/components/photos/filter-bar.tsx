"use client";

import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FilterOption } from "@/lib/photos/filter-options";

export const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-1.5 text-xs ${
    active
      ? "border-[#2680FC] bg-[#2680FC] text-white"
      : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0]"
  }`;

/** One dropdown filter chip. */
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1 ${chipClass(Boolean(active))}`}
        >
          {active ?? label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="border-[#4e4e4e] bg-[#2e2e2e] text-white">
        {active && (
          <DropdownMenuItem
            onClick={onClear}
            className="text-[#a0a0a0] focus:bg-[#3e3e3e] focus:text-white"
          >
            Clear {label.toLowerCase()}
          </DropdownMenuItem>
        )}
        {options.length === 0 && (
          <DropdownMenuItem disabled className="text-[#7e7e7e]">
            None yet
          </DropdownMenuItem>
        )}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className="focus:bg-[#3e3e3e] focus:text-white"
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
