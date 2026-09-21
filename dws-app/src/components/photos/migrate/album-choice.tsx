'use client';

import { useEffect, useId, useState } from 'react';
import { fetchJson } from '@/lib/photos/api';
import { cleanAlbumName } from '@/lib/photos/migration/folders';
import { field, hint } from './styles';

// The album for loose photos: none, an existing album, or a new one (plan AC-18). One text box:
// typing lists the albums that match, and whatever is typed that is not picked is a new album.

export type AlbumValue = { kind: 'none' } | { kind: 'new'; name: string } | { kind: 'existing'; id: string; name: string };
type AlbumRef = { id: string; name: string; photo_count: number };

interface AlbumChoiceProps {
  value: AlbumValue;
  onChange(value: AlbumValue): void;
  inputId?: string;
  disabled?: boolean;
}

export default function AlbumChoice({ value, onChange, inputId, disabled }: AlbumChoiceProps) {
  const [text, setText] = useState(value.kind === 'none' ? '' : value.name);
  const [albums, setAlbums] = useState<AlbumRef[]>([]);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  useEffect(() => { setText(value.kind === 'none' ? '' : value.name); }, [value]);

  useEffect(() => {
    if (!focused) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchJson<{ albums: AlbumRef[] }>(`/api/photo-albums?q=${encodeURIComponent(text.trim())}`, 'Albums could not be loaded', { signal: controller.signal, cache: 'no-store' })
        .then(result => setAlbums(result.albums.slice(0, 8))).catch(() => { if (!controller.signal.aborted) setAlbums([]); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [focused, text]);

  const settle = () => {
    const name = cleanAlbumName(text);
    if (!name) { if (value.kind !== 'none') onChange({ kind: 'none' }); return; }
    if (value.kind !== 'none' && value.name === name) return;
    // Typing an existing album's exact name means that album, not a second one with the same name.
    const same = albums.find(album => album.name.toLowerCase() === name.toLowerCase());
    onChange(same ? { kind: 'existing', id: same.id, name: same.name } : { kind: 'new', name });
  };
  const typed = cleanAlbumName(text);
  const exact = albums.some(album => album.name.toLowerCase() === typed.toLowerCase());

  return (
    // `relative`: the list floats over what is below. It comes and goes with focus, and a list that
    // pushed the page around would make the next click miss (see folder-tags.tsx).
    <div className="relative">
      <input id={inputId} type="text" value={text} maxLength={120} disabled={disabled} className={field} placeholder="Type a new album, or find one"
        role="combobox" aria-expanded={focused && albums.length > 0} aria-controls={listId} aria-autocomplete="list"
        onChange={event => setText(event.target.value)} onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); settle(); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
      {focused && (albums.length > 0 || typed) && (
        <ul id={listId} role="listbox" aria-label="Albums" className="absolute left-0 right-0 top-11 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-[#555] bg-[#262626] p-1 shadow-lg shadow-black/40">
          {albums.map(album => (
            <li key={album.id} role="option" aria-selected={value.kind === 'existing' && value.id === album.id}>
              {/* onMouseDown: choose before the input's blur settles the half-typed text as a new album. */}
              <button type="button" onMouseDown={event => { event.preventDefault(); onChange({ kind: 'existing', id: album.id, name: album.name }); setFocused(false); (document.activeElement as HTMLElement | null)?.blur(); }}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-base text-white hover:bg-[#3a3a3a]">
                <span className="break-words">{album.name}</span>
                <span className="shrink-0 text-[#c4c4c4]">{album.photo_count.toLocaleString()} {album.photo_count === 1 ? 'photo' : 'photos'}</span>
              </button>
            </li>
          ))}
          {typed && !exact && <li className="px-3 py-2 text-base text-[#c4c4c4]" role="presentation">New album “{typed}”</li>}
        </ul>
      )}
      {/* Two lines reserved: this sentence changes when the field settles on blur, and must not move what is below it. */}
      <p className={`${hint} mt-1 min-h-12`}>
        {value.kind === 'existing' ? `These photos will be added to the album “${value.name}”.`
          : value.kind === 'new' ? `A new album “${value.name}” will be made when the first photo is imported.`
          : 'An album is like a folder. A photo can be in more than one.'}
      </p>
    </div>
  );
}
