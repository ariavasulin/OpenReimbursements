"use client";

import { useMemo, useRef } from "react";
import { X } from "lucide-react";
import { appendTag, tagSuggestions, toTagPairs } from "@/lib/photos/tags";

// Tag chip editor shared by the upload sheet and the lightbox edit panel:
// chips with a remove button plus a free-text input (Enter or comma adds),
// with optional suggestion chips from the tags already in use.

interface TagInputProps {
  tags: string[];
  input: string;
  onInputChange(value: string): void;
  /** A new, trimmed tag (never blank or a duplicate). Must also clear the input. */
  onAdd(tag: string): void;
  onRemove(tag: string): void;
  /** Tags already in use; matching ones render as chips under the field. */
  suggestions?: string[];
  disabled?: boolean;
  /** Wrapper margin classes (the two hosts space it differently). */
  className?: string;
  /** id for the text input, so a host label can point at it. */
  inputId?: string;
}

export default function TagInput({
  tags,
  input,
  onInputChange,
  onAdd,
  onRemove,
  suggestions,
  disabled,
  className = "",
  inputId,
}: TagInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pairs = useMemo(() => toTagPairs(suggestions ?? []), [suggestions]);
  const matches = useMemo(
    () => tagSuggestions(pairs, input, tags),
    [pairs, input, tags]
  );

  return (
    <>
      <div
        className={`${className} flex flex-wrap items-center gap-1.5 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-2.5 py-2`}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full border border-[#4e4e4e] bg-[#2e2e2e] py-0.5 pl-2.5 pr-1 text-xs text-white"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onRemove(tag)}
              disabled={disabled}
              className="rounded-full p-1.5"
            >
              <X className="h-3 w-3 text-[#a0a0a0]" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              const next = appendTag(tags, input);
              // onAdd clears the input itself (one state transition); clearing
              // here too would overwrite the add from a stale value.
              if (next !== tags) onAdd(next[next.length - 1]);
              else onInputChange("");
            }
          }}
          placeholder={tags.length === 0 ? "Add a tag..." : ""}
          disabled={disabled}
          className="min-w-[90px] flex-1 bg-transparent py-0.5 text-base text-white md:text-sm placeholder:text-[#b4b4b4] focus:outline-none"
        />
      </div>
      {matches.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {matches.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => {
                onAdd(tag);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-2.5 py-1 text-xs text-[#d0d0d0] hover:border-[#2680FC]"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
