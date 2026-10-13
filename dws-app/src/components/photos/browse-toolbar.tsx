"use client";

import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DateRangeFields from "@/components/photos/date-range-fields";
import {
  ActiveFilterChips,
  activeFilters,
  chipClass,
  FavoritesChip,
  FILE_TYPE_OPTIONS,
  FilterChip,
  TagsFilterChip,
  type FilterChoices,
} from "@/components/photos/filter-bar";
import FilterSheet from "@/components/photos/filter-sheet";
import GroupByToggle, { SortToggle } from "@/components/photos/group-by-toggle";
import {
  activeFilterCount,
  dateFilterLabel,
  type BrowseFilters,
} from "@/lib/photos/browse-state";
import type { PhotoSort } from "@/lib/photos/api";
import type { GroupBy } from "@/lib/photos/group";
import { cn } from "@/lib/utils";

/** Desktop's Date chip: the same choices as the phone's Date section, in a popover. */
function DateFilterChip({
  filters,
  onChange,
}: {
  filters: BrowseFilters;
  onChange(change: Partial<BrowseFilters>): void;
}) {
  const [open, setOpen] = useState(false);
  const active = filters.from || filters.to ? dateFilterLabel(filters) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={active ? `Date: ${active}` : "Filter by date"}
          className={`max-w-full gap-1.5 ${chipClass(Boolean(active))}`}
        >
          <span className="min-w-0 truncate">{active ?? "Date"}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        aria-label="Date"
        className="w-[min(24rem,calc(100vw-2rem))] border-[#4e4e4e] bg-[#2e2e2e] p-3 text-white"
      >
        <DateRangeFields
          key={`${filters.from}|${filters.to}`}
          value={filters}
          onChange={(range) => {
            onChange(range ?? { from: null, to: null });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A photo grid's toolbar, one row: Filter (with the number of filters on),
 * Group by, Sort. On a phone Filter opens a pop-up with every filter and
 * carries the count of those on; on desktop the same filters sit in the row
 * as chips, and under the row each active filter is a chip with ×, then Clear.
 */
export default function BrowseToolbar({
  filters,
  choices,
  onFiltersChange,
  onClear,
  groupModes,
  group,
  onGroupChange,
  sort,
  onSortChange,
  customSort = false,
  showView,
}: {
  filters: BrowseFilters;
  choices: FilterChoices;
  onFiltersChange(change: Partial<BrowseFilters>): void;
  onClear(): void;
  groupModes: readonly GroupBy[];
  group: GroupBy;
  onGroupChange(group: GroupBy): void;
  sort: PhotoSort;
  onSortChange(sort: PhotoSort): void;
  /** Offer Sort Custom (an arranged album). */
  customSort?: boolean;
  /** Group by and Sort only help once there are photos (or a failed page to retry). */
  showView: boolean;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const count = activeFilterCount(filters);
  const projectLabel = filters.project
    ? choices.projects?.find((option) => option.value === filters.project)?.label ?? "Project"
    : null;
  const uploaderLabel = filters.uploader
    ? choices.uploaders.find((option) => option.value === filters.uploader)?.label ?? "Uploader"
    : null;

  return (
    <>
      {/* One row on a phone (the Filter button plus two icon chips fit 390px);
          wider screens may wrap the desktop filter chips. */}
      <div className="mb-2 flex flex-row flex-nowrap items-center gap-2 sm:flex-wrap">
        <div role="group" aria-label="Filters" className="flex shrink-0 items-center gap-2 sm:min-w-0 sm:max-w-full sm:shrink sm:flex-wrap">
          <button
            type="button"
            aria-label={count > 0 ? `Filter, ${count} on` : "Filter"}
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
            // A round 44px icon on a phone, so Filter, Group by, and Sort fit one
            // row at 390px; the word comes back where there is room. What is
            // on is spelled out by the chips under the row.
            className={cn(
              "relative w-11 justify-center px-0 sm:w-auto sm:gap-1.5 sm:px-3 desktop:hidden",
              chipClass(count > 0)
            )}
          >
            <SlidersHorizontal className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Filter</span>
            {count > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-[#222222] bg-white px-1 text-xs font-semibold text-[#2680FC] sm:static sm:border-0">
                {count}
              </span>
            )}
          </button>
          <div className="hidden desktop:contents">
            {choices.projects && (
              <FilterChip
                label="Project"
                active={projectLabel}
                options={choices.projects}
                onSelect={(project) => onFiltersChange({ project })}
                onClear={() => onFiltersChange({ project: null })}
              />
            )}
            <FilterChip
              label="Uploader"
              active={uploaderLabel}
              options={choices.uploaders}
              onSelect={(uploader) => onFiltersChange({ uploader })}
              onClear={() => onFiltersChange({ uploader: null })}
              clearLabel="Show everyone"
            />
            <TagsFilterChip
              selected={filters.tags}
              options={choices.tags}
              onChange={(tags) => onFiltersChange({ tags })}
            />
            <FilterChip
              label="File type"
              active={filters.type}
              options={FILE_TYPE_OPTIONS}
              onSelect={(type) => onFiltersChange({ type: type as BrowseFilters["type"] })}
              onClear={() => onFiltersChange({ type: null })}
            />
            <DateFilterChip filters={filters} onChange={onFiltersChange} />
            <FavoritesChip active={filters.favorites} onChange={(favorites) => onFiltersChange({ favorites })} />
          </div>
        </div>
        {/* How the photos are laid out, not which ones. One left-aligned row
            with the Filter button on a phone; at desktop it sits at the far
            right of the chips. Wraps rather than pushing the page sideways. */}
        {showView && (
          <div
            role="group"
            aria-label="View"
            className="flex min-w-0 max-w-full flex-nowrap items-center gap-2 sm:flex-wrap desktop:ml-auto"
          >
            {groupModes.length > 1 && (
              <GroupByToggle modes={groupModes} value={group} onChange={onGroupChange} />
            )}
            <SortToggle value={sort} onChange={onSortChange} custom={customSort} />
          </div>
        )}
      </div>

      <ActiveFilterChips
        chips={activeFilters(filters, choices)}
        onRemove={onFiltersChange}
        onClear={onClear}
      />

      <FilterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        filters={filters}
        choices={choices}
        onChange={onFiltersChange}
        onClear={onClear}
      />
    </>
  );
}
