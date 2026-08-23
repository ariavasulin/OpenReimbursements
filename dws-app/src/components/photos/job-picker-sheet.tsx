"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft } from "lucide-react";
import FullScreenSheet from "@/components/photos/full-screen-sheet";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// Full-screen job search for phones. Its own search input means the keyboard
// only ever covers a list that is designed to be covered — never the sheet.

// The full-screen list has room; filterJobs' default cap is a dropdown constraint.
const FULL_LIST_LIMIT = 50;

interface JobPickerSheetProps {
  jobs: PhotoJobSummary[];
  /** Currently selected job id ("" for none); shown first and marked. */
  value: string;
  open: boolean;
  onClose(): void;
  onSelect(job: PhotoJobSummary): void;
}

export default function JobPickerSheet({
  jobs,
  value,
  open,
  onClose,
  onSelect,
}: JobPickerSheetProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardInset = useKeyboardInset(open);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const results = useMemo(() => {
    const matches = filterJobs(jobs, query, FULL_LIST_LIMIT);
    const currentIndex = matches.findIndex((job) => job.id === value);
    if (currentIndex <= 0) return matches;
    return [
      matches[currentIndex],
      ...matches.slice(0, currentIndex),
      ...matches.slice(currentIndex + 1),
    ];
  }, [jobs, query, value]);

  return (
    <FullScreenSheet
      open={open}
      onClose={onClose}
      title="Pick a job"
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
          className="min-w-0 flex-1 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none"
        />
      </div>

      <ul
        aria-label="Jobs"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        // Lift the tail of the list above the keyboard so every row is reachable.
        style={{
          paddingBottom: `calc(${keyboardInset}px + env(safe-area-inset-bottom))`,
        }}
      >
        {results.map((job) => {
          const current = job.id === value;
          return (
            <li key={job.id}>
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => onSelect(job)}
                className={cn(
                  "flex w-full items-baseline gap-2 border-b border-[#2e2e2e] px-4 py-3.5 text-left text-base text-white active:bg-[#2e2e2e]",
                  current && "border-l-2 border-l-[#2680FC] bg-[#2e2e2e]"
                )}
              >
                <span className="shrink-0 text-[#2680FC]">#{job.job_number}</span>
                <span className="truncate">{job.name}</span>
                {current && (
                  <Check
                    aria-hidden="true"
                    className="ml-auto h-4 w-4 shrink-0 self-center text-[#2680FC]"
                  />
                )}
              </button>
            </li>
          );
        })}
        {results.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-[#a0a0a0]">
            No matching jobs
          </li>
        )}
      </ul>
    </FullScreenSheet>
  );
}
