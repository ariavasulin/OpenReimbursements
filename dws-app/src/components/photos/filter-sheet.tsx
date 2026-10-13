"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import DateRangeFields, { fieldClass } from "@/components/photos/date-range-fields";
import { chipClass, FILE_TYPE_OPTIONS, type FilterChoices, FavoritesChip } from "@/components/photos/filter-bar";
import SheetShell from "@/components/photos/sheet-shell";
import { activeFilterCount, type BrowseFilters } from "@/lib/photos/browse-state";
import type { FilterOption } from "@/lib/photos/filter-options";
import { cn } from "@/lib/utils";

const sectionHeading = "mb-2 text-sm font-semibold text-white";

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-4 first:mt-1">
      <h3 id={id} className={sectionHeading}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One choice from a long list (projects, people): the phone's own picker does
 * that best. The browser's arrow is replaced by our chevron, drawn inside the
 * field (Safari pushed its own against the edge and clipped it); pr-10 keeps
 * the text clear of it, and the chevron lets taps through to the picker.
 */
function OptionSelect({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: string | null;
  options: FilterOption[];
  onChange(value: string | null): void;
}) {
  const known = value === null || options.some((option) => option.value === value);
  return (
    <div className="relative">
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={cn(fieldClass, "truncate pr-10")}
      >
        <option value="">{anyLabel}</option>
        {!known && value !== null && <option value={value}>{label}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[#b4b4b4]"
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * The phone's Filter pop-up: Project (not on a project page), Uploader, Tags
 * (several), File type, and Date. Every choice applies at once, so the grid
 * behind is already the answer when the pop-up closes.
 */
export default function FilterSheet({
  open,
  onOpenChange,
  filters,
  choices,
  onChange,
  onClear,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  filters: BrowseFilters;
  choices: FilterChoices;
  onChange(change: Partial<BrowseFilters>): void;
  onClear(): void;
}) {
  const id = useId();
  const count = activeFilterCount(filters);
  // Tags from the URL that no loaded photo shows yet still get their chip.
  const tagOptions = [
    ...filters.tags
      .filter((tag) => !choices.tags.some((option) => option.value === tag))
      .map((tag) => ({ value: tag, label: tag })),
    ...choices.tags,
  ];

  return (
    <SheetShell
      open={open}
      onOpenChange={onOpenChange}
      title="Filter"
      cancelLabel="Close"
      footer={
        <div className="flex gap-2">
          {count > 0 && (
            <Button
              variant="outline"
              size="lg"
              onClick={onClear}
              className="h-auto min-h-11 flex-1 border-[#4e4e4e] bg-transparent py-2.5 text-base text-white hover:bg-white/10 hover:text-white"
            >
              Clear all
            </Button>
          )}
          <Button
            size="lg"
            onClick={() => onOpenChange(false)}
            className="h-auto min-h-11 flex-1 bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
          >
            Done
          </Button>
        </div>
      }
    >
      {choices.projects && (
        <Section title="Project" id={`${id}-project`}>
          <OptionSelect
            label="Project"
            anyLabel="Any project"
            value={filters.project}
            options={choices.projects}
            onChange={(project) => onChange({ project })}
          />
        </Section>
      )}
      <Section title="Uploader" id={`${id}-uploader`}>
        <OptionSelect
          label="Uploader"
          anyLabel="Anyone"
          value={filters.uploader}
          options={choices.uploaders}
          onChange={(uploader) => onChange({ uploader })}
        />
      </Section>
      <Section title="Tags" id={`${id}-tags`}>
        {tagOptions.length === 0 ? (
          <p className="text-sm text-[#b4b4b4]">No tags on these photos yet.</p>
        ) : (
          <div role="group" aria-label="Tags" className="flex flex-wrap gap-2">
            {tagOptions.map((option) => {
              const pressed = filters.tags.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() =>
                    onChange({
                      tags: pressed
                        ? filters.tags.filter((tag) => tag !== option.value)
                        : [...filters.tags, option.value],
                    })
                  }
                  className={`max-w-full ${chipClass(pressed)}`}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
        {filters.tags.length > 1 && (
          <p className="mt-1.5 text-sm text-[#b4b4b4]">Showing photos with every tag picked.</p>
        )}
      </Section>
      <Section title="Favorites" id={`${id}-favorites`}>
        <FavoritesChip active={filters.favorites} onChange={(favorites) => onChange({ favorites })} />
        <p className="mt-1.5 text-sm text-[#b4b4b4]">Only the photos you put a heart on. Nobody else sees your hearts.</p>
      </Section>
      <Section title="File type" id={`${id}-type`}>
        <div role="group" aria-label="File type" className="flex flex-wrap gap-2">
          {FILE_TYPE_OPTIONS.map((option) => {
            const pressed = filters.type === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={pressed}
                onClick={() => onChange({ type: pressed ? null : (option.value as BrowseFilters["type"]) })}
                className={chipClass(pressed)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Date" id={`${id}-date`}>
        {/* Keyed so a Clear resets its Custom range fields too. */}
        <DateRangeFields
          key={`${filters.from}|${filters.to}`}
          value={filters}
          onChange={(range) => onChange(range ?? { from: null, to: null })}
        />
      </Section>
    </SheetShell>
  );
}
