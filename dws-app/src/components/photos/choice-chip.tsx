"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chipClass, menuClass, menuItemClass } from "@/components/photos/filter-bar";
import { cn } from "@/lib/utils";

/**
 * A view setting (Group by, Sort) as one chip that reads as a sentence —
 * "Group by Date ▾", "Sort Newest ▾" — and opens to its choices. One chip
 * per setting keeps the toolbar short on a phone, where a segmented control
 * of four or five words would not fit. The chip is never blue: blue is how a
 * filter says it is narrowing the photos, and these do not.
 */
export default function ChoiceChip<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  /** The setting, shown in front of the choice and naming the menu. */
  name: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  const current = options.find((option) => option.value === value)?.label ?? "";
  const triggerRef = useRef<HTMLButtonElement>(null);
  // How the menu was last used. A pick made by mouse or touch hands focus back
  // to the chip without a focus ring, which would otherwise make it look like
  // an active (blue) filter; a keyboard pick keeps the ring.
  const byPointer = useRef(false);
  const [quietFocus, setQuietFocus] = useState(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${name}: ${current}`}
          onPointerDown={() => {
            byPointer.current = true;
          }}
          onKeyDown={() => {
            byPointer.current = false;
            setQuietFocus(false);
          }}
          onBlur={() => setQuietFocus(false)}
          className={cn(
            "min-w-0 max-w-full gap-1.5",
            chipClass(false),
            quietFocus && "focus-visible:ring-0 focus-visible:ring-offset-0"
          )}
        >
          <span className="whitespace-nowrap text-[#a0a0a0]">{name}</span>
          <span className="min-w-0 truncate font-medium text-white">{current}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={16}
        onPointerDown={() => {
          byPointer.current = true;
        }}
        onKeyDown={() => {
          byPointer.current = false;
        }}
        onPointerDownOutside={() => {
          byPointer.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (!byPointer.current) return;
          event.preventDefault();
          setQuietFocus(true);
          triggerRef.current?.focus({ preventScroll: true });
        }}
        className={cn("min-w-[11rem]", menuClass)}
      >
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className={cn(menuItemClass, "pl-8")}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
