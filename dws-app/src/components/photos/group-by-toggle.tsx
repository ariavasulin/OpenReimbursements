"use client";

import ChoiceChip from "@/components/photos/choice-chip";
import type { GroupBy } from "@/lib/photos/group";
import type { PhotoSort } from "@/lib/photos/api";

const MODE_LABEL: Record<GroupBy, string> = {
  date: "Date",
  tag: "Tag",
  uploader: "Uploader",
  type: "File type",
  job: "Project",
};

/**
 * How the grid groups, named in front of the choice: a bare "Date" or "Tag"
 * beside the filters would read as two more filters.
 */
export default function GroupByToggle<T extends GroupBy>({
  modes,
  value,
  onChange,
}: {
  modes: readonly T[];
  value: T;
  onChange(mode: T): void;
}) {
  return (
    <ChoiceChip
      name="Group by"
      options={modes.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
      value={value}
      onChange={onChange}
    />
  );
}

const SORT_OPTIONS: readonly { value: PhotoSort; label: string }[] = [
  { value: "desc", label: "Newest" },
  { value: "asc", label: "Oldest" },
];

/** Newest or oldest capture first; the server pages in that order. */
export function SortToggle({
  value,
  onChange,
}: {
  value: PhotoSort;
  onChange(sort: PhotoSort): void;
}) {
  return <ChoiceChip name="Sort" options={SORT_OPTIONS} value={value} onChange={onChange} />;
}
