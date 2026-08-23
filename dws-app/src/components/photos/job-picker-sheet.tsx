"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft } from "lucide-react";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";

// Full-screen job search for phones. Its own search input means the keyboard
// only ever covers a list that is designed to be covered — never the sheet.
// Same nested-dialog shell as BatchPreview (z-[60], data-vaul-no-drag) so it
// stacks above the upload Drawer and swipes inside it don't drag the drawer.

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

  // The full-screen list has room; the 8-cap is a dropdown constraint.
  const results = useMemo(() => filterJobs(jobs, query, 50), [jobs, query]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-[#222222]" />
        <DialogPrimitive.Content
          data-vaul-no-drag
          aria-describedby={undefined}
          // Don't hand focus back to the field on close: on iOS that re-triggers
          // keyboard/viewport churn while the drawer is settling.
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed inset-0 z-[60] flex flex-col bg-[#222222] text-white focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            Pick a job
          </DialogPrimitive.Title>

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
                  <span className="shrink-0 text-[#2680FC]">
                    #{job.job_number}
                  </span>
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
