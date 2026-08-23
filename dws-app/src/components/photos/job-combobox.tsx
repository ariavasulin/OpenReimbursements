"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import JobPickerSheet from "@/components/photos/job-picker-sheet";
import { useSheetLayout } from "@/components/photos/sheet-shell";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// Job field for the upload/edit sheets, picked by the enclosing SheetShell's
// layout:
// - JobTypeahead (desktop): a text field whose suggestions render in a
//   portaled Popover anchored to it, so the list floats over the fields below
//   and never changes the sheet's layout.
// - JobPickerField (phones): a button-like field that opens JobPickerSheet, a
//   full-screen search step, so the keyboard never fights the drawer.

/** What the field needs to name a selected job; PhotoJobSummary satisfies it. */
export type JobLabelSource = { job_number: string; name: string };

interface JobFieldProps {
  jobs: PhotoJobSummary[];
  /** Selected job id, or "" for none. */
  value: string;
  onChange(jobId: string): void;
  disabled?: boolean;
  /** True while `jobs` is still fetching: the field shows "Loading jobs...". */
  jobsLoading?: boolean;
  /** Label source when `value` is set but absent from `jobs` (e.g. editing
   *  a photo before the list has loaded). */
  fallback?: JobLabelSource | null;
  /** id for the button (picker) or input (typeahead), for a host label. */
  inputId?: string;
}

function jobLabel(job: JobLabelSource) {
  return `#${job.job_number} · ${job.name}`;
}

function useSelectedJob(
  jobs: PhotoJobSummary[],
  value: string,
  fallback: JobLabelSource | null | undefined
): JobLabelSource | null {
  return useMemo(
    () =>
      value ? (jobs.find((job) => job.id === value) ?? fallback ?? null) : null,
    [jobs, value, fallback]
  );
}

export default function JobField(props: JobFieldProps) {
  const { isMobile } = useSheetLayout();
  return isMobile ? <JobPickerField {...props} /> : <JobTypeahead {...props} />;
}

export function JobPickerField({
  jobs,
  value,
  onChange,
  disabled,
  jobsLoading,
  fallback,
  inputId,
}: JobFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = useSelectedJob(jobs, value, fallback);

  return (
    <div className="mb-3.5">
      <button
        id={inputId}
        type="button"
        disabled={disabled || jobsLoading}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen(true)}
        className="flex w-full items-center justify-between rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-left text-base text-white disabled:opacity-50"
      >
        <span className={selected ? "truncate" : "text-[#b4b4b4]"}>
          {selected
            ? jobLabel(selected)
            : jobsLoading
              ? "Loading jobs..."
              : "Pick a job..."}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#b4b4b4]" />
      </button>
      <JobPickerSheet
        jobs={jobs}
        value={value}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(job) => {
          onChange(job.id);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

export function JobTypeahead({
  jobs,
  value,
  onChange,
  disabled,
  jobsLoading,
  fallback,
  inputId,
}: JobFieldProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useSelectedJob(jobs, value, fallback);
  const suggestions = useMemo(
    () => (selected ? [] : filterJobs(jobs, query)),
    [jobs, query, selected]
  );
  const noMatches = query.trim().length > 0 && suggestions.length === 0;
  const listOpen =
    open && !selected && !jobsLoading && (suggestions.length > 0 || noMatches);

  // Keyboard navigation must keep the highlighted option visible.
  useEffect(() => {
    if (!listOpen) return;
    document
      .getElementById(`${listId}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listOpen, listId, activeIndex]);

  // Any change to the query restarts the highlight at the top.
  const changeQuery = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
  };
  const select = (job: PhotoJobSummary) => {
    onChange(job.id);
    changeQuery("");
    setOpen(false);
  };
  const clear = () => {
    onChange("");
    changeQuery("");
  };

  return (
    <div className="mb-3.5">
      <Popover open={listOpen} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="flex items-center rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] focus-within:border-[#2680FC]">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              aria-expanded={listOpen}
              aria-controls={listId}
              aria-activedescendant={
                listOpen && suggestions.length > 0
                  ? `${listId}-${activeIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={selected ? jobLabel(selected) : query}
              readOnly={Boolean(selected)}
              onChange={(event) => {
                changeQuery(event.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={(event) => {
                if (selected) {
                  if (event.key === "Backspace") {
                    event.preventDefault();
                    clear();
                  }
                  return;
                }
                switch (event.key) {
                  case "ArrowDown":
                    event.preventDefault();
                    setOpen(true);
                    setActiveIndex((i) =>
                      Math.min(i + 1, Math.max(suggestions.length - 1, 0))
                    );
                    break;
                  case "ArrowUp":
                    event.preventDefault();
                    setActiveIndex((i) => Math.max(i - 1, 0));
                    break;
                  case "Enter":
                    if (listOpen && suggestions[activeIndex]) {
                      event.preventDefault();
                      select(suggestions[activeIndex]);
                    }
                    break;
                  case "Escape":
                    if (listOpen) {
                      event.preventDefault();
                      setOpen(false);
                    } else {
                      changeQuery("");
                    }
                    break;
                }
              }}
              placeholder={
                jobsLoading ? "Loading jobs..." : "Search by job # or name..."
              }
              disabled={disabled || jobsLoading}
              className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:outline-none disabled:opacity-50 md:text-sm"
            />
            {selected && (
              <button
                type="button"
                aria-label="Clear job"
                onClick={clear}
                disabled={disabled}
                className="px-3 py-2.5 text-[#b4b4b4] hover:text-white disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </PopoverAnchor>

        <PopoverContent
          align="start"
          sideOffset={4}
          // Keep focus (and the keyboard) in the input.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Clicks on the field itself must not close the list.
            if (inputRef.current?.contains(event.target as Node)) {
              event.preventDefault();
            }
          }}
          // 21rem fits filterJobs' 8-item cap at ~40px per option.
          className="max-h-[21rem] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] p-0 text-white shadow-md"
        >
          <div id={listId} role="listbox">
            {suggestions.map((job, index) => (
              <div
                key={job.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // onMouseDown fires before the input's blur, so the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(job)}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 px-3 py-2.5 text-sm",
                  index === activeIndex && "bg-[#353535]"
                )}
              >
                <span className="shrink-0 text-[#a0a0a0]">#{job.job_number}</span>
                <span className="truncate">{job.name}</span>
              </div>
            ))}
          </div>
          {noMatches && (
            <div role="status" className="px-3 py-2.5 text-xs text-[#a0a0a0]">
              No matching jobs
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
