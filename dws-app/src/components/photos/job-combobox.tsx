"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";

// Text-field job picker for the upload sheet. Suggestions render inline
// below the field (no floating popover: inside a Drawer on iOS those bled
// off-screen).

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
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(blurTimer.current ?? undefined), []);

  const selected = useMemo(
    () => jobs.find((job) => job.id === value) ?? null,
    [jobs, value]
  );
  const suggestions = useMemo(
    () => (selected ? [] : filterJobs(jobs, query)),
    [jobs, query, selected]
  );
  const listOpen = focused && !selected && suggestions.length > 0;

  const select = (job: PhotoJobSummary) => {
    onChange(job.id);
    setQuery("");
  };
  const clear = () => {
    onChange("");
    setQuery("");
  };

  return (
    <div className="mb-3.5">
      <div className="flex items-center rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] focus-within:border-[#2680FC]">
        <input
          type="text"
          role="combobox"
          aria-expanded={listOpen}
          aria-autocomplete="list"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={selected ? jobLabel(selected) : query}
          readOnly={Boolean(selected)}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            clearTimeout(blurTimer.current ?? undefined);
            setFocused(true);
          }}
          // Delay so a tap on a suggestion registers before the list hides.
          onBlur={() => {
            blurTimer.current = setTimeout(() => setFocused(false), 150);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !selected && suggestions.length > 0) {
              event.preventDefault();
              select(suggestions[0]);
            } else if (event.key === "Escape" && !selected) {
              setQuery("");
            } else if (event.key === "Backspace" && selected) {
              event.preventDefault();
              clear();
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

      {listOpen && (
        <ul
          role="listbox"
          className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#4e4e4e] bg-[#2e2e2e]"
        >
          {suggestions.map((job, index) => (
            <li key={job.id} role="option" aria-selected={index === 0}>
              <button
                type="button"
                // onMouseDown fires before the input's blur, so the tap lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(job)}
                className={`flex w-full items-baseline gap-2 px-3 py-2.5 text-left text-sm text-white hover:bg-[#3e3e3e] ${
                  index === 0 ? "bg-[#353535]" : ""
                }`}
              >
                <span className="shrink-0 text-[#a0a0a0]">#{job.job_number}</span>
                <span className="truncate">{job.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {focused && !selected && query.trim() && suggestions.length === 0 && (
        <div className="mt-1 px-1 text-xs text-[#a0a0a0]">No matching jobs</div>
      )}
    </div>
  );
}
