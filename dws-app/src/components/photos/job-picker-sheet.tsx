"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import FullScreenSheet from "@/components/photos/full-screen-sheet";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";

// Full-screen job search for phones. Its own search input means the keyboard
// only ever covers a list that is designed to be covered — never the sheet.

// The full-screen list has room; filterJobs' default cap is a dropdown constraint.
const FULL_LIST_LIMIT = 50;

interface JobPickerSheetProps {
  jobs: PhotoJobSummary[];
  open: boolean;
  onClose(): void;
  onSelect(job: PhotoJobSummary): void;
}

export default function JobPickerSheet({
  jobs,
  open,
  onClose,
  onSelect,
}: JobPickerSheetProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const results = useMemo(
    () => filterJobs(jobs, query, FULL_LIST_LIMIT),
    [jobs, query]
  );

  return (
    <FullScreenSheet
      open={open}
      onClose={onClose}
      title="Pick a job"
      // Don't hand focus back to the field on close: on iOS that re-triggers
      // keyboard/viewport churn while the drawer is settling.
      onCloseAutoFocus={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[calc(0.75rem_+_env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="rounded-full p-2 hover:bg-white/10"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) onSelect(results[0]);
          }}
          placeholder="Job # or name"
          className="min-w-0 flex-1 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none"
        />
      </div>

      <ul
        role="listbox"
        aria-label="Jobs"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
      >
        {results.map((job) => (
          <li key={job.id} role="option" aria-selected={false}>
            <button
              type="button"
              onClick={() => onSelect(job)}
              className="flex w-full items-baseline gap-2 border-b border-[#2e2e2e] px-4 py-3.5 text-left text-base text-white active:bg-[#2e2e2e]"
            >
              <span className="shrink-0 text-[#2680FC]">#{job.job_number}</span>
              <span className="truncate">{job.name}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-[#a0a0a0]">
            No matching jobs
          </li>
        )}
      </ul>
    </FullScreenSheet>
  );
}
