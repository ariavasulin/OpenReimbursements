"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { usePhotoTags } from "@/lib/photos/api";
import {
  appendResolvedTag,
  TAG_EXPLAINER,
  tagChoices,
  tagMenu,
} from "@/lib/photos/tags";
import { useCloseOnBlur } from "@/hooks/use-close-on-blur";
import { MAX_TAGS } from "@/lib/photos/apiShared";
import { cn } from "@/lib/utils";

// The one tag field, used by the upload pop-up, Edit details, and bulk Tag.
// It opens to the tags already in use plus the three starter tags, narrows as
// you type, and ends with `Add "<typed>"`. What is typed is matched, ignoring
// case, against those choices before it is kept, so "Professional" becomes the
// existing "professional" instead of a second spelling.
//
// The list renders inline under the field rather than in a floating layer: the
// field lives inside a Drawer on phones and a Dialog on desktop, and an inline
// list behaves the same in both (no focus trap or outside-tap fights).

/** Existing tags plus the starter tags, for the dropdown and for saving. */
export function useTagChoices(enabled: boolean): string[] {
  const { data: knownTags } = usePhotoTags(enabled);
  return useMemo(() => tagChoices(knownTags ?? []), [knownTags]);
}

interface TagDropdownProps {
  tags: string[];
  onChange(tags: string[]): void;
  /** The half-typed text. The host owns it so Save can keep it as one more tag. */
  input: string;
  onInputChange(value: string): void;
  /** From useTagChoices. */
  choices: string[];
  disabled?: boolean;
  /** id for the text input, so a host label can point at it. */
  inputId?: string;
  ariaLabel?: string;
  /** Import rows save typed text when leaving the field. */
  commitOnBlur?: boolean;
  /** Import rows use a floating list to keep the next row in place. */
  floating?: boolean;
  showHint?: boolean;
  className?: string;
}

export default function TagDropdown({
  tags,
  onChange,
  input,
  onInputChange,
  choices,
  disabled,
  inputId,
  ariaLabel,
  commitOnBlur = false,
  floating = false,
  showHint = true,
  className,
}: TagDropdownProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const closeOnBlur = useCloseOnBlur(inputRef, () => setOpen(false));

  const menu = useMemo(() => tagMenu(choices, tags, input), [choices, tags, input]);
  const rowCount = menu.options.length + (menu.add ? 1 : 0);
  const full = tags.length >= MAX_TAGS;
  const listOpen = open && !disabled && !full && rowCount > 0;

  const add = (raw: string) => {
    const next = appendResolvedTag(tags, raw, choices);
    if (!full && next !== tags) onChange(next);
    onInputChange("");
    setActiveIndex(0);
  };

  const pickActive = () => {
    if (listOpen && activeIndex < menu.options.length) add(menu.options[activeIndex]);
    else add(input);
  };

  return (
    <div className={cn("relative", className)}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-2.5 py-1.5 focus-within:border-[#2680FC]">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center rounded-full border border-[#4e4e4e] bg-[#2e2e2e] py-0.5 pl-3 text-sm text-white"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((have) => have !== tag))}
              disabled={disabled}
              className="flex h-8 w-8 items-center justify-center rounded-full text-[#b4b4b4] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          aria-label={ariaLabel}
          type="text"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listOpen ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={input}
          onChange={(event) => {
            onInputChange(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (commitOnBlur && input.trim()) add(input);
            closeOnBlur();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              pickActive();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, Math.max(rowCount - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Backspace" && !input && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          placeholder={tags.length === 0 ? "Choose or type a tag" : "Add another"}
          disabled={disabled || full}
          className="min-h-9 min-w-[120px] flex-1 bg-transparent text-base text-white placeholder:text-[#b4b4b4] focus:outline-none"
        />
      </div>

      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tags"
          // Keeps the keyboard up and the field focused while a row is tapped.
          onMouseDown={(event) => event.preventDefault()}
          className={cn("mt-1 max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-[#4e4e4e] bg-[#262626]", floating && "absolute left-0 right-0 top-full z-20 shadow-lg")}
        >
          {menu.options.map((option, index) => (
            <li
              key={option}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                add(option);
                inputRef.current?.focus();
              }}
              className={cn(
                "flex min-h-11 cursor-pointer items-center break-words px-3 py-2 text-base text-white",
                index === activeIndex && "bg-[#353535]"
              )}
            >
              {option}
            </li>
          ))}
          {menu.add && (
            <li
              id={`${listId}-${menu.options.length}`}
              role="option"
              aria-selected={activeIndex === menu.options.length}
              onMouseEnter={() => setActiveIndex(menu.options.length)}
              onClick={() => {
                add(menu.add!);
                inputRef.current?.focus();
              }}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 break-words px-3 py-2 text-base text-[#8bbaff]",
                menu.options.length > 0 && "border-t border-[#4e4e4e]",
                activeIndex === menu.options.length && "bg-[#353535]"
              )}
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              Add &ldquo;{menu.add}&rdquo;
            </li>
          )}
        </ul>
      )}

      {showHint && <p className="mt-1.5 text-sm text-[#b4b4b4]">{TAG_EXPLAINER}</p>}
      {full && <p className="mt-1.5 text-sm text-[#b4b4b4]">A photo can have up to {MAX_TAGS} tags.</p>}
    </div>
  );
}
