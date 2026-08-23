"use client";

import { useId } from "react";
import JobField, { type JobLabelSource } from "@/components/photos/job-combobox";
import TagInput from "@/components/photos/tag-input";
import { usePhotoJobs, usePhotoTags } from "@/lib/photos/api";
import { addTagToMeta, type PhotoMeta } from "@/lib/photos/tags";

// The job / sheet # / tags form shared by the upload and edit sheets. Owns the
// jobs and tags queries; the host owns the values.

export type { PhotoMeta } from "@/lib/photos/tags";

export const EMPTY_META: PhotoMeta = {
  jobId: "",
  sheetNumber: "",
  tags: [],
  tagInput: "",
};

interface PhotoMetaFieldsProps {
  value: PhotoMeta;
  /** Functional, so two edits in one event (add tag + clear input) compose. */
  onChange(update: (prev: PhotoMeta) => PhotoMeta): void;
  /** Whether to fetch jobs/tags (pass the sheet's `open`). */
  enabled?: boolean;
  disabled?: boolean;
  /** Label for the selected job when it isn't in the jobs list (edit sheet). */
  jobFallback?: JobLabelSource | null;
}

const labelClass = "mb-1.5 block text-xs text-[#a0a0a0]";

export default function PhotoMetaFields({
  value,
  onChange,
  enabled = true,
  disabled,
  jobFallback,
}: PhotoMetaFieldsProps) {
  const { data: jobs, isLoading: jobsLoading } = usePhotoJobs(enabled);
  const { data: knownTags } = usePhotoTags(enabled);
  const id = useId();
  const jobInputId = `${id}-job`;
  const sheetInputId = `${id}-sheet`;
  const tagInputId = `${id}-tags`;

  const patch = (changes: Partial<PhotoMeta>) =>
    onChange((prev) => ({ ...prev, ...changes }));

  return (
    <>
      <label htmlFor={jobInputId} className={labelClass}>
        Job
      </label>
      <JobField
        inputId={jobInputId}
        jobs={jobs ?? []}
        jobsLoading={jobsLoading}
        value={value.jobId}
        fallback={jobFallback}
        onChange={(jobId) => patch({ jobId })}
        disabled={disabled}
      />

      <label htmlFor={sheetInputId} className={labelClass}>
        Sheet # (optional)
      </label>
      <input
        id={sheetInputId}
        type="text"
        inputMode="numeric"
        value={value.sheetNumber}
        onChange={(event) => patch({ sheetNumber: event.target.value })}
        placeholder="e.g. 12"
        disabled={disabled}
        className="mb-3.5 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none md:text-sm"
      />

      <label htmlFor={tagInputId} className={labelClass}>
        Tags (optional)
      </label>
      <TagInput
        className="mb-1"
        inputId={tagInputId}
        tags={value.tags}
        input={value.tagInput}
        onInputChange={(tagInput) => patch({ tagInput })}
        onAdd={(tag) => onChange((prev) => addTagToMeta(prev, tag))}
        onRemove={(tag) =>
          onChange((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }))
        }
        suggestions={knownTags}
        disabled={disabled}
      />
    </>
  );
}
