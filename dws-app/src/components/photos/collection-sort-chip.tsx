"use client";

import { ArrowUpDown } from "lucide-react";
import ChoiceChip from "@/components/photos/choice-chip";
import { PAGE_TITLE_CLASS } from "@/components/photos/page-layout";

/**
 * A list page's name with its Sort chip at the far end of the same row: the
 * chip the photo grids' toolbar uses, so it reads "Sort Job number ▾" and opens
 * to the same kind of menu. On a phone the chip shows its icon and the choice.
 */
export default function CollectionTitleRow<T extends string>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
      <ChoiceChip
        name="Sort"
        icon={<ArrowUpDown className="h-4 w-4" />}
        options={options}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
