'use client';

import { useEffect, type RefObject } from 'react';

/** Radix dialogs handle Escape on document capture; the focused field gets first refusal. */
export function useSuggestionEscape(input: RefObject<HTMLInputElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.target !== input.current) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [input, open, close]);
}
