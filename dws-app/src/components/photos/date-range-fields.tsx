"use client";

import { useId, useState } from "react";
import { chipClass } from "@/components/photos/filter-bar";
import {
  customRange,
  DATE_PRESETS,
  matchingPreset,
  presetRange,
  toDayInput,
  type DateRange,
} from "@/lib/photos/browse-state";
import { cn } from "@/lib/utils";

/**
 * A field in the filter controls (the Project and Uploader pickers, the Custom
 * range days): exactly 44px, the chips' fill, border, and 12px inset, and 16px
 * text so iPhone Safari does not zoom the page on focus. appearance-none drops
 * Safari's own field look; color-scheme keeps the browser's pickers dark.
 */
export const fieldClass =
  "block h-11 w-full min-w-0 appearance-none rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] px-3 text-base leading-normal text-white [color-scheme:dark] focus:border-[#2680FC] focus:outline-none";

// iPhone Safari centres a date's value and gives an empty date field no
// height; these keep the day left-aligned like the pickers above it.
const dayInputClass = `${fieldClass} text-left [&::-webkit-date-and-time-value]:min-h-[1.5em] [&::-webkit-date-and-time-value]:text-left`;

/**
 * The Date filter's choices, the same in the phone's Filter pop-up and the
 * desktop Date chip: This week, This month, This year (each applies at once,
 * and a second tap takes it off), or a Custom range of whole days picked with
 * the browser's own date picker and applied with one button.
 */
export default function DateRangeFields({
  value,
  onChange,
}: {
  value: DateRange;
  /** Null: no date filter. */
  onChange(range: DateRange | null): void;
}) {
  const id = useId();
  const active = value.from !== null || value.to !== null;
  const preset = active ? matchingPreset(value) : null;
  const [custom, setCustom] = useState(active && preset === null);
  const [fromDay, setFromDay] = useState(() => toDayInput(value.from));
  const [toDay, setToDay] = useState(() => toDayInput(value.to));
  const range = customRange(fromDay, toDay);

  return (
    <div>
      <div role="group" aria-label="Date" className="flex flex-wrap gap-2">
        {DATE_PRESETS.map((option) => {
          const pressed = !custom && preset === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => {
                setCustom(false);
                onChange(pressed ? null : presetRange(option.value));
              }}
              className={chipClass(pressed)}
            >
              {option.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={custom}
          onClick={() => setCustom(true)}
          className={chipClass(custom)}
        >
          Custom range
        </button>
      </div>
      {custom && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2">
            <label htmlFor={`${id}-from`} className="min-w-0 text-sm text-[#d0d0d0]">
              From
              <input
                id={`${id}-from`}
                type="date"
                value={fromDay}
                onChange={(event) => setFromDay(event.target.value)}
                className={cn("mt-1", dayInputClass)}
              />
            </label>
            <label htmlFor={`${id}-to`} className="min-w-0 text-sm text-[#d0d0d0]">
              To
              <input
                id={`${id}-to`}
                type="date"
                value={toDay}
                onChange={(event) => setToDay(event.target.value)}
                className={cn("mt-1", dayInputClass)}
              />
            </label>
          </div>
          <p className="mt-1.5 text-sm text-[#b4b4b4]">Both days are included. Leave one empty for no limit.</p>
          <button
            type="button"
            disabled={range === null}
            onClick={() => range && onChange(range)}
            className="mt-2 flex min-h-11 w-full items-center justify-center rounded-lg bg-[#2680FC] px-4 text-base font-medium text-white hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
          >
            Show these dates
          </button>
        </div>
      )}
    </div>
  );
}
