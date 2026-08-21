"use client";

import { X } from "lucide-react";

// Tag chip editor shared by the upload sheet and the lightbox edit panel:
// chips with a remove button plus a free-text input (Enter or comma adds).

interface TagInputProps {
  tags: string[];
  input: string;
  onInputChange(value: string): void;
  onAdd(raw: string): void;
  onRemove(tag: string): void;
  disabled?: boolean;
  /** Wrapper margin classes (the two hosts space it differently). */
  className?: string;
}

export default function TagInput({
  tags,
  input,
  onInputChange,
  onAdd,
  onRemove,
  disabled,
  className = "",
}: TagInputProps) {
  return (
    <div
      className={`${className} flex flex-wrap items-center gap-1.5 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-2.5 py-2`}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-2.5 py-1 text-xs text-white"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onRemove(tag)}
            disabled={disabled}
          >
            <X className="h-3 w-3 text-[#a0a0a0]" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            onAdd(input);
          }
        }}
        placeholder={tags.length === 0 ? "Add a tag..." : ""}
        disabled={disabled}
        className="min-w-[90px] flex-1 bg-transparent py-0.5 text-sm text-white placeholder:text-[#a0a0a0] focus:outline-none"
      />
    </div>
  );
}
