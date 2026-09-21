"use client";

import { useId } from "react";
import JobField from "@/components/photos/job-combobox";
import TagInput from "@/components/photos/tag-input";
import { usePhotoJobs, usePhotoTags } from "@/lib/photos/api";
import { addTagToMeta, type PhotoMeta } from "@/lib/photos/tags";

// The job / tags form shared by the upload and edit sheets. Owns the
// jobs and tags queries; the host owns the values.

export type { PhotoMeta } from "@/lib/photos/tags";

export const EMPTY_META: PhotoMeta = {
  jobId: "",
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
  showJob?: boolean;
}

const labelClass = "mb-1.5 block text-xs text-[#a0a0a0]";

export default function PhotoMetaFields({
  value,
  onChange,
  enabled = true,
  disabled,
  showJob = true,
}: PhotoMetaFieldsProps) {
  const {
    data: jobs,
    isLoading: jobsLoading,
    error: jobsError,
    refetch: refetchJobs,
  } = usePhotoJobs(enabled && showJob);
  const { data: knownTags } = usePhotoTags(enabled);
  const id = useId();
  const jobInputId = `${id}-job`;
  const tagInputId = `${id}-tags`;

  const patch = (changes: Partial<PhotoMeta>) =>
    onChange((prev) => ({ ...prev, ...changes }));

  return (
    <>
      {showJob && <><label htmlFor={jobInputId} className={labelClass}>
        Job
      </label>
      <JobField
        inputId={jobInputId}
        jobs={jobs ?? []}
        jobsLoading={jobsLoading}
        value={value.jobId}
        onChange={(jobId) => patch({ jobId })}
        disabled={disabled}
      />
      {jobsError && (
        <p className="-mt-2 mb-3.5 text-xs text-red-300">
          Couldn&apos;t load jobs.{" "}
          <button
            type="button"
            onClick={() => refetchJobs()}
            className="underline hover:text-white"
          >
            Retry
          </button>
        </p>
      )}
      </>}

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
