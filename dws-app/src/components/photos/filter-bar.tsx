"use client";

import { ChevronDown, X, Heart } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { dateFilterLabel, type BrowseFilters } from "@/lib/photos/browse-state";
import { FILE_TYPE_LABELS } from "@/lib/photos/file-type";
import type { FilterOption } from "@/lib/photos/filter-options";
import { cn } from "@/lib/utils";

// The pieces of a grid's filters that the phone's Filter pop-up and the
// desktop's inline chips share: the choices on offer, the chips, and the row
// of active filters under the toolbar.

/** What each filter offers on this page. `projects` is null where there is no Project filter. */
export interface FilterChoices {
  projects: FilterOption[] | null;
  uploaders: FilterOption[];
  tags: FilterOption[];
}

export const FILE_TYPE_OPTIONS: FilterOption[] = FILE_TYPE_LABELS.map((label) => ({
  value: label,
  label,
}));

const labelOf = (options: FilterOption[] | null, value: string, fallback: string) =>
  options?.find((option) => option.value === value)?.label ?? fallback;

/** One active filter as a removable chip: what it reads, and the change that removes it. */
export interface ActiveFilter {
  key: string;
  label: string;
  remove: Partial<BrowseFilters>;
}

export function activeFilters(filters: BrowseFilters, choices: FilterChoices): ActiveFilter[] {
  const chips: ActiveFilter[] = [];
  if (filters.project) {
    chips.push({ key: "project", label: labelOf(choices.projects, filters.project, "Project"), remove: { project: null } });
  }
  if (filters.uploader) {
    chips.push({ key: "uploader", label: labelOf(choices.uploaders, filters.uploader, "Uploader"), remove: { uploader: null } });
  }
  for (const tag of filters.tags) {
    chips.push({ key: `tag:${tag}`, label: tag, remove: { tags: filters.tags.filter((other) => other !== tag) } });
  }
  if (filters.type) chips.push({ key: "type", label: filters.type, remove: { type: null } });
  if (filters.from || filters.to) {
    chips.push({ key: "date", label: dateFilterLabel(filters), remove: { from: null, to: null } });
  }
  if (filters.favorites) chips.push({ key: "favorites", label: "Favorites", remove: { favorites: false } });
  return chips;
}

/**
 * The personal filter: only the photos this person put a heart on. One chip
 * that is on or off, in the row beside the real tags on desktop and in the
 * phone's Filter sheet. Blue when on, like any narrowing filter.
 */
export function FavoritesChip({ active, onChange }: { active: boolean; onChange(favorites: boolean): void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(!active)}
      className={`gap-1.5 ${chipClass(active)}`}
    >
      <Heart className={`h-4 w-4 shrink-0 ${active ? "fill-current" : ""}`} aria-hidden="true" />
      Favorites
    </button>
  );
}

/**
 * The active filters under the toolbar, each with its own ×, then Clear.
 * Desktop only: on a phone the Filter button's count says how many are on,
 * and the sheet it opens is where each one is turned off, so a second row of
 * the same blue chips under it only stacked two blue shapes.
 */
export function ActiveFilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: ActiveFilter[];
  onRemove(change: Partial<BrowseFilters>): void;
  onClear(): void;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="mb-2 hidden min-w-0 max-w-full flex-wrap items-center gap-2 desktop:flex">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          aria-label={`Remove filter ${chip.label}`}
          onClick={() => onRemove(chip.remove)}
          className={cn("max-w-full gap-1 pr-2", chipClass(true))}
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          <X className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-[#8bbaff] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
      >
        Clear
      </button>
    </div>
  );
}

/** 44px tall: these are everyday controls for people on phones in the field. */
export const chipClass = (active: boolean) =>
  `flex min-h-11 items-center rounded-full border px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] focus-visible:ring-offset-2 focus-visible:ring-offset-[#222222] ${
    active
      ? "border-[#2680FC] bg-[#2680FC] font-medium text-white"
      : "border-[#4e4e4e] bg-[#2e2e2e] text-[#d0d0d0] hover:border-[#6e6e6e]"
  }`;

/** The open menu under a chip, and its rows. */
export const menuClass = "border-[#4e4e4e] bg-[#2e2e2e] p-1 text-white";
export const menuItemClass = "min-h-11 px-3 text-base focus:bg-[#2680FC] focus:text-white";

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
  clearLabel = `Show every ${label.toLowerCase()}`,
}: {
  label: string;
  active: string | null;
  options: FilterOption[];
  onSelect(value: string): void;
  onClear(): void;
  /** The menu row that takes the filter off. */
  clearLabel?: string;
}) {
  if (options.length === 0 && !active) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // Spelled out: "Tag" alone is also a Group by choice on the same screen.
          aria-label={active ? `${label}: ${active}` : `Filter by ${label.toLowerCase()}`}
          className={`max-w-full gap-1.5 ${chipClass(Boolean(active))}`}
        >
          <span className="min-w-0 truncate">{active ?? label}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={16}
        className={cn("max-h-[60dvh] max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto", menuClass)}
      >
        {active && (
          <DropdownMenuItem
            onClick={onClear}
            className={cn(menuItemClass, "text-[#8bbaff]")}
          >
            {clearLabel}
          </DropdownMenuItem>
        )}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className={cn(menuItemClass, "whitespace-normal break-words")}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Tags, several at once (a photo must carry every one): the menu stays open
 * while ticking, so picking two tags is two taps, not two trips.
 */
export function TagsFilterChip({
  selected,
  options,
  onChange,
}: {
  selected: string[];
  options: FilterOption[];
  onChange(tags: string[]): void;
}) {
  if (options.length === 0 && selected.length === 0) return null;
  // A tag in the URL that no loaded photo shows yet still gets its row.
  const rows = [
    ...selected.filter((tag) => !options.some((option) => option.value === tag)).map((tag) => ({ value: tag, label: tag })),
    ...options,
  ];
  const active = selected.length > 0 ? selected.join(", ") : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={active ? `Tags: ${active}` : "Filter by tags"}
          className={`max-w-full gap-1.5 ${chipClass(Boolean(active))}`}
        >
          <span className="min-w-0 truncate">{active ?? "Tags"}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={16}
        className={cn("max-h-[60dvh] max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto", menuClass)}
      >
        {active && (
          <DropdownMenuItem onClick={() => onChange([])} className={cn(menuItemClass, "text-[#8bbaff]")}>
            Show every tag
          </DropdownMenuItem>
        )}
        {rows.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selected, option.value]
                  : selected.filter((tag) => tag !== option.value)
              )
            }
            className={cn(menuItemClass, "whitespace-normal break-words pl-8")}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
