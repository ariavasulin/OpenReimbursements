"use client";

import JobField from "@/components/photos/job-combobox";
import TagInput, { appendTag } from "@/components/photos/tag-input";
import { usePhotoJobs, usePhotoTags } from "@/lib/photos/api";

// The job / sheet # / tags form shared by the upload and edit sheets. Owns the
// jobs and tags queries; the host owns the values.

export interface PhotoMeta {
  /** Selected job id, or "" for none. */
  jobId: string;
  sheetNumber: string;
  tags: string[];
  /** Half-typed tag (saved as one more tag via withPendingTag). */
  tagInput: string;
}

export const EMPTY_META: PhotoMeta = {
  jobId: "",
  sheetNumber: "",
  tags: [],
  tagInput: "",
};

interface PhotoMetaFieldsProps {
  value: PhotoMeta;
  onChange(next: PhotoMeta): void;
  /** Whether to fetch jobs/tags (pass the sheet's `open`). */
  enabled?: boolean;
  disabled?: boolean;
}

export default function PhotoMetaFields({
  value,
  onChange,
  enabled = true,
  disabled,
}: PhotoMetaFieldsProps) {
  const { data: jobs } = usePhotoJobs(enabled);
  const { data: knownTags } = usePhotoTags(enabled);

  const patch = (changes: Partial<PhotoMeta>) =>
    onChange({ ...value, ...changes });

  return (
    <>
      <label className="mb-1.5 block text-xs text-[#a0a0a0]">Job</label>
      <JobField
        jobs={jobs ?? []}
        value={value.jobId}
        onChange={(jobId) => patch({ jobId })}
        disabled={disabled}
      />

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">
        Sheet # (optional)
      </label>
      <input
        type="text"
        inputMode="numeric"
        value={value.sheetNumber}
        onChange={(event) => patch({ sheetNumber: event.target.value })}
        placeholder="e.g. 12"
        disabled={disabled}
        className="mb-3.5 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#a0a0a0] focus:border-[#2680FC] focus:outline-none md:text-sm"
      />

      <label className="mb-1.5 block text-xs text-[#a0a0a0]">
        Tags (optional)
      </label>
      <TagInput
        className="mb-1"
        tags={value.tags}
        input={value.tagInput}
        onInputChange={(tagInput) => patch({ tagInput })}
        onAdd={(tag) => patch({ tags: appendTag(value.tags, tag), tagInput: "" })}
        onRemove={(tag) => patch({ tags: value.tags.filter((t) => t !== tag) })}
        suggestions={knownTags}
        disabled={disabled}
      />
    </>
  );
}
