'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useSuggestionEscape } from '@/hooks/use-suggestion-escape';
import { fetchJson } from '@/lib/photos/api';
import { cleanAlbumName } from '@/lib/photos/migration/folders';
import { field, hint } from './styles';

export type AlbumValue = { kind: 'none' } | { kind: 'new'; name: string } | { kind: 'existing'; id: string; name: string };
type AlbumRef = { id: string; name: string; photo_count: number };

interface AlbumChoiceProps {
  value: AlbumValue;
  onChange(value: AlbumValue): void;
  /** A typed query is not a choice, including when the field loses focus. */
  onPendingChange?(pending: boolean): void;
  inputId?: string;
  disabled?: boolean;
}

export default function AlbumChoice({ value, onChange, onPendingChange, inputId, disabled }: AlbumChoiceProps) {
  const selectedText = value.kind === 'none' ? '' : value.name;
  const [text, setText] = useState(selectedText);
  const [result, setResult] = useState<{ query: string; albums: AlbumRef[] } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => { setText(selectedText); }, [selectedText]);
  const discardQuery = () => { setOpen(false); setText(selectedText); onPendingChange?.(false); };
  useSuggestionEscape(inputRef, open, discardQuery);
  const typed = cleanAlbumName(text);
  const pending = typed !== selectedText;
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError('');
    const timer = setTimeout(() => {
      fetchJson<{ albums: AlbumRef[] }>(`/api/photo-albums?q=${encodeURIComponent(typed)}`, 'Albums could not be loaded', { signal: controller.signal, cache: 'no-store' })
        .then(result => {
          if (!controller.signal.aborted) setResult({ query: typed, albums: result.albums });
        }).catch(() => { if (!controller.signal.aborted) setError('Albums could not be loaded. Focus this field again to retry.'); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, typed]);

  // A stale response must never offer Create for the next query. Search errors also do not
  // imply that no album exists. Creation is an explicit option after a successful lookup.
  const ready = result?.query === typed && !error;
  const exact = ready ? result.albums.find(album => album.name.toLowerCase() === typed.toLowerCase()) : undefined;
  const albums = ready ? (exact ? [exact, ...result.albums.filter(album => album.id !== exact.id)] : result.albums).slice(0, 8) : [];
  const canCreate = Boolean(ready && typed && !exact);
  const rowCount = albums.length + (canCreate ? 1 : 0);
  const active = Math.min(activeIndex, Math.max(0, rowCount - 1));
  const choose = (next: AlbumValue) => {
    onPendingChange?.(false);
    onChange(next);
    setText(next.kind === 'none' ? '' : next.name);
    setOpen(false);
  };
  const pick = (index: number) => {
    const album = albums[index];
    if (album) choose({ kind: 'existing', id: album.id, name: album.name });
    else if (canCreate) choose({ kind: 'new', name: typed });
  };

  return (
    <div className="relative">
      <input ref={inputRef} id={inputId} type="text" value={text} maxLength={120} disabled={disabled} className={field} placeholder="Type a new album, or find one"
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && rowCount ? `${listId}-${active}` : undefined}
        onChange={event => {
          const next = event.target.value;
          setText(next); setResult(null); setActiveIndex(0); setOpen(true);
          onPendingChange?.(cleanAlbumName(next) !== selectedText);
          if (!cleanAlbumName(next)) choose({ kind: 'none' });
        }}
        onFocus={() => { setResult(null); setActiveIndex(0); setOpen(true); }} onBlur={() => setOpen(false)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); if (open && rowCount) pick(active); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex(open ? Math.min(active + 1, Math.max(0, rowCount - 1)) : 0); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(Math.max(0, active - 1)); }
          else if (event.key === 'Escape' && (open || pending)) {
            event.preventDefault(); event.stopPropagation(); discardQuery();
          }
        }} />
      {open && (
        <ul id={listId} role="listbox" aria-label="Albums" onMouseDown={event => event.preventDefault()}
          className="absolute left-0 right-0 top-11 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#555] bg-[#262626] p-1 shadow-lg shadow-black/40">
          {albums.map((album, index) => (
            <li key={album.id} id={`${listId}-${index}`} role="option" aria-selected={active === index}
              onMouseEnter={() => setActiveIndex(index)} onClick={() => pick(index)}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-base text-white ${active === index ? 'bg-[#3a3a3a]' : ''}`}>
              <span className="break-words">{album.name}</span>
              <span className="shrink-0 text-[#c4c4c4]">{album.photo_count.toLocaleString()} {album.photo_count === 1 ? 'photo' : 'photos'}</span>
            </li>
          ))}
          {canCreate && <li id={`${listId}-${albums.length}`} role="option" aria-selected={active === albums.length}
            onMouseEnter={() => setActiveIndex(albums.length)} onClick={() => choose({ kind: 'new', name: typed })}
            className={`min-h-11 cursor-pointer rounded-md px-3 py-2 text-base text-white ${active === albums.length ? 'bg-[#3a3a3a]' : ''}`}>Create album “{typed}”</li>}
          {!ready && <li role="presentation" className="px-3 py-2 text-base text-[#c4c4c4]">{error || 'Looking for albums…'}</li>}
          {ready && !rowCount && <li role="presentation" className="px-3 py-2 text-base text-[#c4c4c4]">Type a name to create an album.</li>}
        </ul>
      )}
      <p className={`${hint} mt-1 min-h-12`}>
        {pending ? 'Choose an album from the list, or choose Create album. Press Escape to keep your previous choice.'
          : value.kind === 'existing' ? `These photos will be added to the album “${value.name}”.`
          : value.kind === 'new' ? `A new album “${value.name}” will be made when the first photo is imported.`
          : 'An album is like a folder. A photo can be in more than one.'}
      </p>
    </div>
  );
}
