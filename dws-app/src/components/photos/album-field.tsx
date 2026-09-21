"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { createAlbum, usePhotoAlbums } from "@/lib/photos/api";
import type { PhotoAlbumRef } from "@/lib/photos/types";
import { useCloseOnBlur } from "@/hooks/use-close-on-blur";
import { cn } from "@/lib/utils";

// Album picker for the upload pop-up and bulk "Add to album": pick one or
// several existing albums, or type a new name and create it on the spot. Built
// like the tag dropdown (chips, a text field, an inline list) so the two read
// as one pattern; see tag-dropdown.tsx for why the list is inline.

interface AlbumFieldProps {
  value: PhotoAlbumRef[];
  onChange(next: PhotoAlbumRef[]): void;
  /** Whether to fetch the album list (pass the pop-up's `open`). */
  enabled?: boolean;
  disabled?: boolean;
  /** id for the text input, so a host label can point at it. */
  inputId?: string;
  className?: string;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function AlbumField({
  value,
  onChange,
  enabled = true,
  disabled,
  inputId,
  className,
}: AlbumFieldProps) {
  const queryClient = useQueryClient();
  const { data: albums, isLoading } = usePhotoAlbums(enabled);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const closeOnBlur = useCloseOnBlur(inputRef, () => setOpen(false));
  const [creating, setCreating] = useState(false);

  const typed = input.trim();
  const options = useMemo(() => {
    const query = typed.toLowerCase();
    return (albums ?? []).filter(
      (album) =>
        !value.some((chosen) => chosen.id === album.id) &&
        album.name.toLowerCase().includes(query)
    );
  }, [albums, value, typed]);
  // Names need not be unique, but offering "Create" for a name that already
  // exists is how accidental twins get made.
  const canCreate =
    typed.length > 0 &&
    !(albums ?? []).some((album) => sameName(album.name, typed)) &&
    !value.some((chosen) => sameName(chosen.name, typed));
  const rowCount = options.length + (canCreate ? 1 : 0);
  const busy = disabled || creating;
  const listOpen = open && !busy && (rowCount > 0 || isLoading);

  const pick = (album: PhotoAlbumRef) => {
    onChange([...value, { id: album.id, name: album.name }]);
    setInput("");
    setActiveIndex(0);
  };

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const { album } = await createAlbum(typed);
      queryClient.invalidateQueries({ queryKey: ["photo-albums"] });
      pick(album);
      toast.success(`Album “${album.name}” created`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to create the album");
    } finally {
      setCreating(false);
      inputRef.current?.focus();
    }
  };

  const pickActive = () => {
    if (activeIndex < options.length) pick(options[activeIndex]);
    else void create();
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-2.5 py-1.5 focus-within:border-[#2680FC]">
        {value.map((album) => (
          <span
            key={album.id}
            className="flex min-w-0 items-center rounded-full border border-[#4e4e4e] bg-[#2e2e2e] py-0.5 pl-3 text-sm text-white"
          >
            <span className="min-w-0 break-words">{album.name}</span>
            <button
              type="button"
              aria-label={`Remove album ${album.name}`}
              onClick={() => onChange(value.filter((chosen) => chosen.id !== album.id))}
              disabled={busy}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#b4b4b4] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listOpen && rowCount > 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={120}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={closeOnBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (listOpen && rowCount > 0) pickActive();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, Math.max(rowCount - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Backspace" && !input && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          placeholder={
            creating
              ? "Creating the album..."
              : value.length === 0
                ? "Choose an album or type a new name"
                : "Add another"
          }
          disabled={busy}
          className="min-h-9 min-w-[140px] flex-1 bg-transparent text-base text-white placeholder:text-[#b4b4b4] focus:outline-none disabled:opacity-60"
        />
      </div>

      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Albums"
          onMouseDown={(event) => event.preventDefault()}
          className="mt-1 max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-[#4e4e4e] bg-[#262626]"
        >
          {isLoading && rowCount === 0 && (
            <li className="px-3 py-3 text-sm text-[#b4b4b4]">Loading albums...</li>
          )}
          {options.map((album, index) => (
            <li
              key={album.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                pick(album);
                inputRef.current?.focus();
              }}
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-base text-white",
                index === activeIndex && "bg-[#353535]"
              )}
            >
              <span className="min-w-0 break-words">{album.name}</span>
              <span className="shrink-0 text-sm text-[#b4b4b4]">
                {album.photo_count} {album.photo_count === 1 ? "photo" : "photos"}
              </span>
            </li>
          ))}
          {canCreate && (
            <li
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={activeIndex === options.length}
              onMouseEnter={() => setActiveIndex(options.length)}
              onClick={() => void create()}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 break-words px-3 py-2 text-base text-[#8bbaff]",
                options.length > 0 && "border-t border-[#4e4e4e]",
                activeIndex === options.length && "bg-[#353535]"
              )}
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              Create album &ldquo;{typed}&rdquo;
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
