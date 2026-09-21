"use client";

import { useId } from "react";
import AlbumField from "@/components/photos/album-field";
import JobField from "@/components/photos/job-combobox";
import TagDropdown from "@/components/photos/tag-dropdown";
import { usePhotoJobs } from "@/lib/photos/api";
import type { PhotoMeta } from "@/lib/photos/tags";

// The project / album / tags form shared by the upload pop-up and Edit details.
// Owns the project list query; the host owns the values and the tag choices
// (it needs them again on save, to keep a half-typed tag).

export type { PhotoMeta } from "@/lib/photos/tags";

export const EMPTY_META: PhotoMeta = {
  jobId: "",
  albums: [],
  tags: [],
  tagInput: "",
};

interface PhotoMetaFieldsProps {
  value: PhotoMeta;
  /** Functional, so two edits in one event (add tag + clear input) compose. */
  onChange(update: (prev: PhotoMeta) => PhotoMeta): void;
  /** From useTagChoices: existing tags plus the starter tags. */
  tagChoices: string[];
  /** Whether to fetch projects and albums (pass the pop-up's `open`). */
  enabled?: boolean;
  disabled?: boolean;
  /** Project and Album fields: the upload pop-up shows them, Edit details does not. */
  showDestination?: boolean;
}

const labelClass = "mb-1.5 block text-sm font-medium text-[#d0d0d0]";

export default function PhotoMetaFields({
  value,
  onChange,
  tagChoices,
  enabled = true,
  disabled,
  showDestination = true,
}: PhotoMetaFieldsProps) {
  const {
    data: jobs,
    isLoading: jobsLoading,
    error: jobsError,
    refetch: refetchJobs,
  } = usePhotoJobs(enabled && showDestination);
  const id = useId();
  const jobInputId = `${id}-project`;
  const albumInputId = `${id}-album`;
  const tagInputId = `${id}-tags`;

  const patch = (changes: Partial<PhotoMeta>) =>
    onChange((prev) => ({ ...prev, ...changes }));

  return (
    <>
      {showDestination && (
        <>
          <label htmlFor={jobInputId} className={labelClass}>
            Project (optional)
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
            <p className="-mt-2 mb-3.5 text-sm text-red-300">
              Couldn&apos;t load projects.{" "}
              <button
                type="button"
                onClick={() => refetchJobs()}
                className="underline hover:text-white"
              >
                Retry
              </button>
            </p>
          )}

          <label htmlFor={albumInputId} className={labelClass}>
            Album (optional)
          </label>
          <AlbumField
            className="mb-3.5"
            inputId={albumInputId}
            value={value.albums}
            onChange={(albums) => patch({ albums })}
            enabled={enabled}
            disabled={disabled}
          />
        </>
      )}

      <label htmlFor={tagInputId} className={labelClass}>
        Tags (optional)
      </label>
      <TagDropdown
        className="mb-1"
        inputId={tagInputId}
        tags={value.tags}
        onChange={(tags) => patch({ tags })}
        input={value.tagInput}
        onInputChange={(tagInput) => patch({ tagInput })}
        choices={tagChoices}
        disabled={disabled}
      />
    </>
  );
}
