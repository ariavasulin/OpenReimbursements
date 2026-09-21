'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Play, X } from 'lucide-react';
import type { SharedPage, SharedPhoto } from '@/lib/photos/server/sharing';

// The public share page's grid and viewer (photo-albums plan, Phase 7). Self-contained on purpose:
// it uses none of the signed-in app's grid, viewer, shell, or data hooks, so nothing that needs a
// login -- or that shows a person, a tag, or another album -- can arrive here by reuse. It knows
// only what /api/share/<token> returns. Same dark palette and compact square grid as the app.

const plural = (count: number, one: string) => `${count.toLocaleString()} ${count === 1 ? one : `${one}s`}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const iconButton = 'inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC] disabled:opacity-30';

export default function SharedGallery({ token, first }: { token: string; first: SharedPage }) {
  const [photos, setPhotos] = useState<SharedPhoto[]>(first.photos);
  const [next, setNext] = useState<string | null>(first.next);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true); setProblem('');
    try {
      const response = await fetch(`/api/share/${token}?after=${encodeURIComponent(next)}`, { cache: 'no-store', referrerPolicy: 'no-referrer' });
      // The link may have been turned off since the page opened. Say so plainly; do not pretend it is a glitch.
      if (response.status === 404) { setNext(null); setProblem('This link has been turned off, so no more photos can be shown.'); return; }
      if (!response.ok) throw new Error();
      const page = await response.json() as SharedPage;
      setPhotos(current => { const seen = new Set(current.map(photo => photo.id)); return [...current, ...page.photos.filter(photo => !seen.has(photo.id))]; });
      setNext(page.next);
    } catch { setProblem('More photos could not be loaded. Check your connection and try again.'); }
    finally { setLoading(false); }
  }, [next, loading, token]);

  const close = useCallback(() => { setOpen(null); opener.current?.focus(); }, []);
  const step = useCallback((by: number) => setOpen(index => index === null ? index : Math.min(photos.length - 1, Math.max(0, index + by))), [photos.length]);
  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); else if (event.key === 'ArrowRight') step(1); else if (event.key === 'ArrowLeft') step(-1); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, step]);
  // Near the end of what is loaded: fetch the next page so "next" never runs dry.
  useEffect(() => { if (open !== null && open >= photos.length - 3) void loadMore(); }, [open, photos.length, loadMore]);

  const current = open === null ? null : photos[open];
  return (
    <main className="h-dvh overflow-y-auto bg-[#222222] text-white">
      <div className="mx-auto max-w-6xl px-3 py-6 sm:px-6">
        <header className="px-1 pb-5">
          <p className="text-base text-[#c4c4c4]">{first.kind === 'album' ? 'Shared album' : 'Shared project'}</p>
          <h1 className="mt-1 break-words text-3xl font-semibold">{first.name}</h1>
          <p className="mt-1 text-base text-[#c4c4c4]" data-testid="shared-count">{plural(first.count, 'photo')}</p>
        </header>
        {photos.length === 0
          ? <p className="rounded-xl bg-[#2e2e2e] p-6 text-base text-[#c4c4c4]">There are no photos here yet.</p>
          : <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6" data-testid="shared-grid">
              {photos.map((photo, index) => (
                <li key={photo.id} className="relative aspect-square overflow-hidden bg-[#2e2e2e]">
                  <button type="button" aria-label={`Open ${photo.kind === 'video' ? 'video' : 'photo'} ${index + 1} of ${first.count}, taken ${day(photo.captured_at)}`}
                    onClick={event => { opener.current = event.currentTarget; setOpen(index); }}
                    className="block h-full w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#2680FC]">
                    {photo.thumb_url
                      // eslint-disable-next-line @next/next/no-img-element -- a plain <img>: the public page must not route images through the app's optimizer
                      ? <img src={photo.thumb_url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                      : <span className="flex h-full w-full items-center justify-center px-2 text-center text-base text-[#c4c4c4]">No preview</span>}
                    {photo.kind === 'video' && <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-sm"><Play className="h-3.5 w-3.5" aria-hidden />Video</span>}
                  </button>
                </li>
              ))}
            </ul>}
        {problem && <p role="alert" className="mt-4 rounded-lg border border-amber-900 bg-amber-950/40 p-4 text-base text-amber-200">{problem}</p>}
        {next && <div className="mt-6 flex justify-center"><button type="button" onClick={() => void loadMore()} disabled={loading}
          className="inline-flex min-h-11 items-center rounded-lg border border-[#555] px-5 text-base font-medium hover:bg-[#444] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC]">
          {loading ? 'Loading…' : `Show more (${(first.count - photos.length).toLocaleString()} left)`}</button></div>}
        <footer className="px-1 pb-4 pt-10 text-base text-[#9a9a9a]">Shared with DWS Photos · Design Workshops</footer>
      </div>

      {current && open !== null && (
        <div role="dialog" aria-modal="true" aria-label={`${current.kind === 'video' ? 'Video' : 'Photo'} ${open + 1} of ${first.count}`} className="fixed inset-0 z-50 flex flex-col bg-black/95">
          <div className="flex items-center justify-between gap-3 p-3">
            <p className="min-w-0 text-base text-[#d6d6d6]"><span className="font-medium text-white">{open + 1} of {first.count.toLocaleString()}</span> · {day(current.captured_at)}</p>
            <div className="flex shrink-0 items-center gap-2">
              <a href={current.download_url} download rel="noreferrer" referrerPolicy="no-referrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#2680FC] px-4 text-base font-semibold text-white hover:bg-[#1a6fd8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                <Download className="h-5 w-5" aria-hidden />Download</a>
              <button type="button" aria-label="Close" autoFocus onClick={close} className={iconButton}><X className="h-6 w-6" aria-hidden /></button>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-3">
            {current.kind === 'video' && current.video_url
              ? <video key={current.id} src={current.video_url} poster={current.preview_url ?? undefined} controls playsInline className="max-h-full max-w-full" />
              : current.preview_url
                // eslint-disable-next-line @next/next/no-img-element -- see above
                ? <img key={current.id} src={current.preview_url} alt="" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />
                : <p className="text-base text-[#c4c4c4]">No preview for this one. You can still download it.</p>}
            <button type="button" aria-label="Previous" disabled={open === 0} onClick={() => step(-1)} className={`${iconButton} absolute left-2 top-1/2 -translate-y-1/2`}><ChevronLeft className="h-6 w-6" aria-hidden /></button>
            <button type="button" aria-label="Next" disabled={open >= photos.length - 1} onClick={() => step(1)} className={`${iconButton} absolute right-2 top-1/2 -translate-y-1/2`}><ChevronRight className="h-6 w-6" aria-hidden /></button>
          </div>
        </div>
      )}
    </main>
  );
}
