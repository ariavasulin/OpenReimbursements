"use client";

import { useMemo, useState } from "react";
import TagDropdown from "@/components/photos/tag-dropdown";
import { tagChoices } from "@/lib/photos/tags";

/** The shared tag field, saving a folder row's complete list as it changes. */
export default function FolderTags({ tags, onChange, known = [], ariaLabel, disabled }: {
  tags: string[];
  onChange(tags: string[]): void;
  known?: string[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState("");
  const choices = useMemo(() => tagChoices(known), [known]);
  if (disabled) return <p className="text-base text-[#c4c4c4]" aria-label={ariaLabel}>{tags.length ? tags.join(", ") : "No tags"}</p>;
  return <TagDropdown tags={tags} onChange={onChange} input={input} onInputChange={setInput}
    choices={choices} ariaLabel={ariaLabel} commitOnBlur floating showHint={false} />;
}
