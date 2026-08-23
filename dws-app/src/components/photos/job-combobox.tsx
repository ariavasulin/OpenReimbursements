"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// Text-field job picker for the upload sheet. Suggestions render in a
// portaled Popover anchored to the field, so the list floats over the fields
// below it and never changes the sheet's layout.

interface JobComboboxProps {
  jobs: PhotoJobSummary[];
  /** Selected job id, or "" for none. */
  value: string;
  onChange(jobId: string): void;
  disabled?: boolean;
}

function jobLabel(job: PhotoJobSummary) {
  return `#${job.job_number} · ${job.name}`;
}

export default function JobCombobox({
  jobs,
  value,
  onChange,
  disabled,
}: JobComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => setActiveIndex(0), [query]);

  const selected = useMemo(
    () => jobs.find((job) => job.id === value) ?? null,
    [jobs, value]
  );
  const suggestions = useMemo(
    () => (selected ? [] : filterJobs(jobs, query)),
    [jobs, query, selected]
  );
  const noMatches = query.trim().length > 0 && suggestions.length === 0;
  const listOpen = open && !selected && (suggestions.length > 0 || noMatches);

  const select = (job: PhotoJobSummary) => {
    onChange(job.id);
    setQuery("");
    setOpen(false);
  };
  const clear = () => {
    onChange("");
    setQuery("");
  };

  return (
    <div className="mb-3.5">
      <Popover open={listOpen} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="flex items-center rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] focus-within:border-[#2680FC]">
            <input
              ref={inputRef}
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
                setQuery(event.target.value);
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
                      setQuery("");
                    }
                    break;
                }
              }}
              placeholder="Search by job # or name..."
              disabled={disabled}
              className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base text-white placeholder:text-[#a0a0a0] focus:outline-none md:text-sm"
            />
            {selected && (
              <button
                type="button"
                aria-label="Clear job"
                onClick={clear}
                disabled={disabled}
                className="px-3 py-2.5 text-[#a0a0a0] hover:text-white disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </PopoverAnchor>

        <PopoverContent
          id={listId}
          role="listbox"
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
          className="max-h-56 w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] p-0 text-white shadow-md"
        >
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
          {noMatches && (
            <div className="px-3 py-2.5 text-xs text-[#a0a0a0]">
              No matching jobs
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
