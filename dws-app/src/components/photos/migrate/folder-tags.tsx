'use client';

import { useId, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { appendTag, tagSuggestions, toTagPairs } from '@/lib/photos/tags';
import { MAX_TAGS } from '@/lib/photos/apiShared';

// Tags for one import row (or for a whole folder of rows).
//
// MERGE NOTE — this is the ONE place import rows choose tags. The plan's Phase 5 builds a shared
// tag dropdown "for upload, edit, bulk tag, and import rows"; when it lands, swap the body of this
// component for it and keep these props. It is separate from TagInput on purpose: TagInput's chips
// are 12px with ~24px remove buttons, below the 44px / 16px standing rules this screen follows.

/** Always offered, even before any photo carries them (plan Decision 5). */
export const STARTER_TAGS = ['professional', 'field dimension', 'shop drawing'];

interface FolderTagsProps {
  tags: string[];
  /** The full next list. The server settles spelling against tags already in use. */
  onChange(tags: string[]): void;
  /** Tags already in use in the library, offered beside the starter tags. */
  known?: string[];
  /** Names what the tags apply to, for screen readers: "Tags for Smith Residence – Finished". */
  ariaLabel: string;
  disabled?: boolean;
}

export default function FolderTags({ tags, onChange, known = [], ariaLabel, disabled }: FolderTagsProps) {
  const [input, setInput] = useState('');
  // Suggestions show only while this field is in use: a list of 100 rows must not grow 300 extra buttons.
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const offered = useMemo(() => {
    const seen = new Set<string>(); const all: string[] = [];
    for (const tag of [...STARTER_TAGS, ...known]) { const key = tag.toLowerCase(); if (!seen.has(key)) { seen.add(key); all.push(tag); } }
    return all;
  }, [known]);
  const pairs = useMemo(() => toTagPairs(offered), [offered]);
  const chosen = useMemo(() => new Set(tags.map(tag => tag.toLowerCase())), [tags]);
  // Typing narrows the list; with nothing typed, the starter tags are offered so the field is never a blank guess.
  const matches = input.trim() ? tagSuggestions(pairs, input, tags) : STARTER_TAGS.filter(tag => !chosen.has(tag));
  const full = tags.length >= MAX_TAGS;

  const add = (raw: string) => {
    const typed = raw.trim();
    // A typed tag that matches an offered one ignoring case takes the offered spelling.
    const spelled = pairs.find(([, lower]) => lower === typed.toLowerCase())?.[0] ?? typed;
    if (spelled && !chosen.has(spelled.toLowerCase()) && !full) onChange(appendTag(tags, spelled));
    setInput('');
  };

  if (disabled) {
    return <p className="text-base text-[#c4c4c4]" aria-label={ariaLabel}>{tags.length ? tags.join(', ') : 'No tags'}</p>;
  }
  return (
    // `relative`: the suggestions float over what is below instead of pushing it down. They appear
    // and vanish with focus, and if that moved the page, pressing a button right after choosing a
    // tag would miss: the button jumps between mouse-down and mouse-up, so no click happens. (It
    // did: "Start import" silently did nothing after a tag was added.)
    <div className="relative">
      {/* No vertical padding: the 44px input and remove buttons set the height, so an empty box is exactly as tall as the project button beside it. */}
      <div className="flex flex-wrap items-center gap-x-2 rounded-lg border border-[#555] bg-[#222222] px-2 focus-within:border-[#2680FC]">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center rounded-full border border-[#4e4e4e] bg-[#2e2e2e] pl-3 text-base text-white">
            <span className="break-all">{tag}</span>
            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter(existing => existing !== tag))}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-[#2680FC]">
              <X className="h-4 w-4 text-[#c4c4c4]" aria-hidden />
            </button>
          </span>
        ))}
        <input type="text" aria-label={ariaLabel} aria-describedby={focused && matches.length ? listId : undefined} value={input} disabled={full}
          onChange={event => setInput(event.target.value)} onFocus={() => setFocused(true)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(input); } }}
          onBlur={() => { setFocused(false); if (input.trim()) add(input); }}
          placeholder={full ? `${MAX_TAGS} tags is the most a photo can have` : tags.length ? 'Add another' : 'Add a tag'}
          className="min-h-11 min-w-[5.5rem] flex-1 bg-transparent px-1 text-base text-white placeholder:text-[#a8a8a8] focus:outline-none" />
      </div>
      {focused && matches.length > 0 && !full && (
        <div id={listId} className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-wrap gap-2 rounded-lg border border-[#555] bg-[#262626] p-2 shadow-lg shadow-black/40">
          {matches.map(tag => (
            // onMouseDown keeps the input's blur from adding half-typed text before the click lands.
            <button key={tag} type="button" onMouseDown={event => event.preventDefault()} onClick={() => add(tag)}
              className="inline-flex min-h-11 items-center rounded-full border border-[#4e4e4e] bg-[#2e2e2e] px-4 text-base text-[#e0e0e0] hover:border-[#2680FC] focus-visible:outline-2 focus-visible:outline-[#2680FC]">
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
