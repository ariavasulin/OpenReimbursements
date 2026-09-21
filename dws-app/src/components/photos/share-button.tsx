'use client';

// Usage: <ShareButton album={{ id, name }} />   or   <ShareButton project={{ id, name }} />
//
// A "Share" button and its pop-up, complete in one file: the on/off switch, the link, Copy, and
// the plain sentence about what turning a link off can and cannot do (photo-albums plan, Phase 7,
// Decision 12, AC-21 to AC-23). It needs nothing from the page it sits on but the target.

import { useCallback, useEffect, useId, useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import SheetShell from '@/components/photos/sheet-shell';
import { fetchJson } from '@/lib/photos/api';

type Target = { id: string; name: string };
type ShareButtonProps = ({ album: Target; project?: never } | { project: Target; album?: never }) & { className?: string };
interface ShareStatus { enabled: boolean; url: string | null; pages_open?: boolean }

/** AC-23: the limit, in plain words. Exported so the test pins the exact sentence people read. */
export const SHARE_LIMIT_SENTENCE = 'Turning the link off stops this page from opening. It cannot take back photos someone has already saved or copied the address of.';

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC]';
const button = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#555] px-4 py-2 text-base font-medium text-white hover:bg-[#444] disabled:opacity-40 ${focus}`;

export default function ShareButton(props: ShareButtonProps) {
  const target = props.album ?? props.project!;
  const what = props.album ? 'album' : 'project';
  const query = props.album ? `album=${props.album.id}` : `job=${props.project!.id}`;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [copied, setCopied] = useState(false);
  const switchId = useId(), linkId = useId();

  useEffect(() => {
    if (!open) return;
    let current = true;
    setStatus(null); setProblem(''); setCopied(false);
    fetchJson<ShareStatus>(`/api/photo-share?${query}`, 'Sharing could not be loaded', { cache: 'no-store', credentials: 'same-origin' })
      .then(result => { if (current) setStatus(result); })
      .catch(() => { if (current) setProblem('Sharing could not be loaded. Close this and try again.'); });
    return () => { current = false; };
  }, [open, query]);

  const turn = useCallback(async (enabled: boolean) => {
    setBusy(true); setProblem(''); setCopied(false);
    try {
      const result = await fetchJson<ShareStatus>('/api/photo-share', 'Sharing could not be changed', { method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(props.album ? { album_id: props.album.id } : { job_id: props.project!.id }), enabled }) });
      setStatus(previous => ({ ...result, pages_open: previous?.pages_open }));
    } catch { setProblem(`The link could not be turned ${enabled ? 'on' : 'off'}. Please try again.`); }
    finally { setBusy(false); }
  }, [props.album, props.project]);

  const copy = async () => {
    if (!status?.url) return;
    try { await navigator.clipboard.writeText(status.url); setCopied(true); }
    catch { setProblem('The link could not be copied. Select it and copy it by hand.'); }
  };

  return (
    <>
      <button type="button" className={`${button} ${props.className ?? ''}`} onClick={() => setOpen(true)}><Share2 className="h-5 w-5" aria-hidden />Share</button>
      <SheetShell title={`Share “${target.name}”`} size="compact" open={open} onOpenChange={setOpen}
        footer={<div className="flex justify-end"><button type="button" className={button} onClick={() => setOpen(false)}>Done</button></div>}>
        <div className="space-y-5 text-white">
          {!status && !problem && <p className="text-base text-[#c4c4c4]" role="status">Loading…</p>}
          {status && <>
            <div className="flex items-start justify-between gap-4">
              <label htmlFor={switchId} className="text-base">
                <span className="block font-medium">Share with a link</span>
                <span className="mt-1 block text-[#c4c4c4]">Anyone who has the link can see and download the photos in this {what}, without signing in. They cannot see who took them, their tags, or anything else in DWS Photos.</span>
              </label>
              <button id={switchId} type="button" role="switch" aria-checked={status.enabled} disabled={busy} onClick={() => void turn(!status.enabled)}
                className={`relative mt-1 inline-flex h-11 w-[4.5rem] shrink-0 items-center rounded-full border border-[#555] transition-colors disabled:opacity-50 ${focus} ${status.enabled ? 'bg-[#2680FC]' : 'bg-[#3a3a3a]'}`}>
                <span className="sr-only">{status.enabled ? 'On' : 'Off'}</span>
                <span aria-hidden className={`inline-block h-9 w-9 rounded-full bg-white transition-transform ${status.enabled ? 'translate-x-[2.1rem]' : 'translate-x-1'}`} />
              </button>
            </div>
            {status.enabled && status.url && (
              <div>
                <label htmlFor={linkId} className="block text-base font-medium">Link</label>
                <div className="mt-1 flex flex-wrap gap-2">
                  <input id={linkId} readOnly value={status.url} onFocus={event => event.currentTarget.select()}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-[#555] bg-[#222222] px-3 text-base text-white focus:border-[#2680FC] focus:outline-none" />
                  <button type="button" className={button} onClick={() => void copy()}>
                    {copied ? <Check className="h-5 w-5 text-green-400" aria-hidden /> : <Copy className="h-5 w-5" aria-hidden />}{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <p className="sr-only" role="status" aria-live="polite">{copied ? 'Link copied' : ''}</p>
              </div>
            )}
            {status.enabled && status.pages_open === false && (
              <p className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-base text-amber-200">Shared links are switched off for everyone at the moment, so this link will not open until they are switched back on.</p>
            )}
            <p className="text-base leading-6 text-[#c4c4c4]" data-testid="share-limit">{SHARE_LIMIT_SENTENCE} If you turn it on again you get a new link; the old one stays off.</p>
          </>}
          {problem && <p role="alert" className="text-base text-red-300">{problem}</p>}
        </div>
      </SheetShell>
    </>
  );
}
