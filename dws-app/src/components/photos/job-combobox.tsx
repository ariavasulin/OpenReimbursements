"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import JobPickerSheet from "@/components/photos/job-picker-sheet";
import NewJobForm from "@/components/photos/new-job-form";
import { useSheetLayout } from "@/components/photos/sheet-shell";
import { useCloseOnBlur } from "@/hooks/use-close-on-blur";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

// Job field for the upload/edit sheets, picked by the enclosing SheetShell's
// layout:
// - JobTypeahead (desktop): a text field whose suggestions render inline under
//   it, like the album and tag fields beside it. (They used to float in a
//   portalled Popover. Inside the pop-up's modal Dialog that list could not be
//   clicked with a mouse: the two Radix packages resolve different copies of
//   their layer bookkeeping, so the Popover never learned it was allowed
//   pointer events. An inline list has no layers to disagree about.)
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
  /** True while `jobs` is still fetching: the field shows "Loading projects...". */
  jobsLoading?: boolean;
  /** Label source when `value` is set but absent from `jobs` (e.g. editing
   *  a photo before the list has loaded). */
  fallback?: JobLabelSource | null;
  /** id for the button (picker) or input (typeahead), for a host label. */
  inputId?: string;
  /** Offer "New project" for the typed text; JobField supplies it. */
  onCreate?(name: string): void;
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
  // null: choosing a job. A string: creating a project, seeded with that name.
  const [creating, setCreating] = useState<string | null>(null);
  // Labels the new job until the refetched `jobs` list carries it.
  const [created, setCreated] = useState<(JobLabelSource & { id: string }) | null>(null);

  if (creating !== null) {
    return (
      <NewJobForm
        jobs={props.jobs}
        initialName={creating}
        onCancel={() => setCreating(null)}
        onDone={(job) => {
          setCreated(job);
          props.onChange(job.id);
          setCreating(null);
        }}
      />
    );
  }
  const field = {
    ...props,
    fallback: props.fallback ?? (created?.id === props.value ? created : null),
    onCreate: props.disabled ? undefined : setCreating,
  };
  return isMobile ? <JobPickerField {...field} /> : <JobTypeahead {...field} />;
}

export function JobPickerField({
  jobs,
  value,
  onChange,
  disabled,
  jobsLoading,
  fallback,
  inputId,
  onCreate,
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
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-left text-base text-white disabled:opacity-50"
      >
        <span className={selected ? "min-w-0 break-words" : "text-[#b4b4b4]"}>
          {selected
            ? jobLabel(selected)
            : jobsLoading
              ? "Loading projects..."
              : "Pick a project"}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#b4b4b4]" />
      </button>
      {selected && !disabled && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="mt-1 flex min-h-11 items-center text-base text-[#8bbaff]"
        >
          Clear project
        </button>
      )}
      <JobPickerSheet
        jobs={jobs}
        value={value}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(job) => {
          onChange(job.id);
          setPickerOpen(false);
        }}
        onCreate={
          onCreate &&
          ((name) => {
            setPickerOpen(false);
            onCreate(name);
          })
        }
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
  onCreate,
}: JobFieldProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const closeOnBlur = useCloseOnBlur(inputRef, () => setOpen(false));

  const selected = useSelectedJob(jobs, value, fallback);
  const suggestions = useMemo(
    () => (selected ? [] : filterJobs(jobs, query)),
    [jobs, query, selected]
  );
  const noMatches = query.trim().length > 0 && suggestions.length === 0;
  // "New project" is one more option after the matches, reachable by arrow keys.
  const canCreate = Boolean(onCreate) && !selected && query.trim().length > 0;
  const lastIndex = suggestions.length - 1 + (canCreate ? 1 : 0);
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
      <div className="flex items-center rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] focus-within:border-[#2680FC]">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-activedescendant={
            listOpen && lastIndex >= 0
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
          onBlur={closeOnBlur}
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
                setActiveIndex((i) => Math.min(i + 1, Math.max(lastIndex, 0)));
                break;
              case "ArrowUp":
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
                break;
              case "Enter":
                if (listOpen && suggestions[activeIndex]) {
                  event.preventDefault();
                  select(suggestions[activeIndex]);
                } else if (listOpen && canCreate && activeIndex === suggestions.length) {
                  event.preventDefault();
                  onCreate?.(query.trim());
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
            jobsLoading ? "Loading projects..." : "Search by project name or number"
          }
          disabled={disabled || jobsLoading}
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:outline-none disabled:opacity-50"
        />
        {selected && (
          <button
            type="button"
            aria-label="Clear project"
            onClick={clear}
            disabled={disabled}
            className="px-3 py-2.5 text-[#b4b4b4] hover:text-white disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {listOpen && (
        <div
          // Keeps focus (and the keyboard) in the input while a row is clicked.
          onMouseDown={(event) => event.preventDefault()}
          className="mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-[#4e4e4e] bg-[#262626] text-white"
        >
          <div id={listId} role="listbox" aria-label="Projects">
            {suggestions.map((job, index) => (
              <div
                key={job.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(job)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-baseline gap-2 px-3 py-2.5 text-base",
                  index === activeIndex && "bg-[#353535]"
                )}
              >
                <span className="shrink-0 text-[#a0a0a0]">#{job.job_number}</span>
                <span className="min-w-0 break-words">{job.name}</span>
              </div>
            ))}
            {canCreate && (
              <div
                id={`${listId}-${suggestions.length}`}
                role="option"
                aria-selected={activeIndex === suggestions.length}
                onMouseEnter={() => setActiveIndex(suggestions.length)}
                onClick={() => onCreate?.(query.trim())}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center break-words border-t border-[#4e4e4e] px-3 py-2.5 text-base text-[#8bbaff]",
                  activeIndex === suggestions.length && "bg-[#353535]"
                )}
              >
                + New project “{query.trim()}”
              </div>
            )}
          </div>
          {noMatches && (
            <div role="status" className="px-3 py-2.5 text-sm text-[#b4b4b4]">
              No matching projects
            </div>
          )}
        </div>
      )}
    </div>
  );
}
