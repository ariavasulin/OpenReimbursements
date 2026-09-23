'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { fetchJson, invalidatePhotoCaches, usePhotoJobs } from '@/lib/photos/api';
import { actionRequest, actionAlert, actionButton as button, actionPrimary as primary, actionField as field, trashDisclosure } from '@/lib/photos/action-client';
import ActionThumbnail from '@/components/photos/action-thumbnail';
import { jobLabel, NO_PROJECT, photoName, plural, projectName } from '@/lib/photos/format';
import { photoPath } from '@/lib/photos/photo-link';

import type { PhotoAction as Action, ActionPhoto as Photo, PhotoActionItem as Item, UnresolvedPhotoReference as Unresolved, PhotoActionBatchResponse as View } from '@/lib/photos/action-types';
import NewJobForm from '@/components/photos/new-job-form';

// The confirm page for Set project, Move to trash, and Restore — for one photo
// or many, from the viewer, the selection bar, the trash, or an assistant's
// hand-off link. It shows the photos first, asks one plain question, and offers
// the verb and Cancel. Detail about a photo that changed underneath you appears
// only when that has actually happened.

const PAGE_SIZE = 50;
/** `?destination=none` and the form's "No project" choice. */
const NO_PROJECT_VALUE = 'none';
const danger = `${button} border-transparent bg-red-600 text-white hover:bg-red-700`;
const tall = 'min-h-11 text-base';

const pageTitle = (action: Action) => action === 'trash' ? 'Move to trash' : action === 'restore' ? 'Restore from trash' : 'Set project';
const label = (photo: Photo | null) => (photo && photoName(photo)) || 'Photo';
/** Where a restored photo lands: back in its project, or "No project" when that project was deleted. */
const restoredTo = (photo: Photo) => photo.job?.deleted_at ? `${NO_PROJECT} (its project was deleted)` : projectName(photo.job, photo.job_id);

/** The one question: "Move 3 photos to <project>?" */
function question(action: Action, count: number, destination: string | null): string {
  const photos = plural(count, 'photo');
  if (action === 'trash') return `Move ${photos} to trash?`;
  if (action === 'restore') return destination ? `Restore ${photos} to ${destination}?` : `Restore ${photos}?`;
  // "No project" is a place like any other here, so it is quoted to read as a name.
  return `Move ${photos} to ${destination === NO_PROJECT ? `“${NO_PROJECT}”` : destination ?? 'this project'}?`;
}
/** What happened, once it has. `count` is null when the list runs past one page. */
function outcome(action: Action, count: number | null, destination: string | null): string {
  const photos = count === null ? 'The photos were' : plural(count, 'photo');
  if (action === 'trash') return `${photos} moved to trash.`;
  if (action === 'restore') return `${photos} restored${destination ? ` to ${destination}` : ''}.`;
  return `${photos} moved to ${destination === NO_PROJECT ? `“${NO_PROJECT}”` : destination ?? 'the project'}.`;
}
const verb = (action: Action, count: number) => action === 'trash' ? 'Move to trash' : action === 'restore' ? (count === 1 ? 'Restore photo' : 'Restore photos') : (count === 1 ? 'Move photo' : 'Move photos');

const BATCH_STATUS: Record<View['batch']['status'], string> = {
  draft: 'Waiting for you', approved: 'Working…', running: 'Working…', interrupted: 'Stopped part-way', completed: 'Done', cancelled: 'Cancelled',
};
const ITEM_STATUS: Record<Item['status'], string> = {
  pending: '', running: 'Working…', applied: 'Done', retryable_failed: 'Did not work', conflict: 'Not changed', skipped: 'Left out', cancelled: 'Cancelled',
};

export default function PhotoActions() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [action, setAction] = useState<Action>('move');
  const [photoId, setPhotoId] = useState('');
  const [destination, setDestination] = useState('');
  const [fromUpload, setFromUpload] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [candidateOffsets, setCandidateOffsets] = useState<Record<number, number>>({});
  const initialized = useRef<string | null>(null);
  const params = useSearchParams();
  const search = params.toString();
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useRef<string | null>(null);
  const { data: jobs } = usePhotoJobs(ready);

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'That did not work. Check your connection and try again.');
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const load = useCallback(async (batchId: string, page = 0) => {
    const next = await actionRequest<View>(`batches/${batchId}?offset=${page}&limit=${PAGE_SIZE}`);
    setView(next); setAction(next.batch.action); setOffset(page); setCandidateOffsets({});
    return next;
  }, []);
  /** Turns the selection into its list of photos in bounded pages. */
  const materialize = async (batchId: string, choices?: Record<number, string | null>) => {
    let next: View;
    do {
      next = await actionRequest<View>(`batches/${batchId}/materialize`, choices ? { choices } : {});
      choices = undefined;
      const wanted = 'photos' in next.batch.selector ? next.batch.selector.photos.length : 0;
      setView(next); setMessage(wanted > 1 ? `Getting the photos ready… ${next.total} of ${wanted}` : 'Getting the photo ready…');
    } while (!next.batch.materialization_complete && !next.unresolved.length);
    setMessage('');
    await load(batchId); heading.current?.focus();
  };
  /** A draft of exactly this photo; nothing changes until it is confirmed. */
  const start = async (chosenAction: Action, chosenPhoto: string, chosenDestination: string) => {
    if (!chosenPhoto) throw new Error('Nothing is selected. Go back and pick a photo first.');
    const created = await actionRequest<{ batch: View['batch'] }>('batches', {
      action: chosenAction, selector: { photos: [{ photo_id: chosenPhoto }] },
      ...(chosenDestination === NO_PROJECT_VALUE ? { destination_job_id: null } : chosenDestination ? { destination_job_id: chosenDestination } : {}),
    });
    id.current = created.batch.id;
    window.history.replaceState(null, '', `${window.location.pathname}?batch=${created.batch.id}`);
    await materialize(created.batch.id);
  };

  useEffect(() => {
    if (initialized.current === search || (params.get('batch') !== null && params.get('batch') === id.current)) return;
    initialized.current = search;
    setView(null); setError(''); setMessage(''); setCandidateOffsets({}); id.current = null;
    void act(async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) { window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      setReady(true);
      const params = new URLSearchParams(window.location.search);
      const chosen = params.get('action');
      const chosenAction: Action = chosen === 'trash' || chosen === 'restore' ? chosen : 'move';
      const chosenPhoto = params.get('photo') ?? '', chosenDestination = params.get('destination') ?? '';
      setAction(chosenAction); setPhotoId(chosenPhoto); setDestination(chosenDestination); setFromUpload(params.get('from') === 'upload');
      let batch = params.get('batch');
      const token = params.get('token');
      if (token) {
        const script = params.get('script_name');
        if (!['move_photos', 'remove_photos', 'restore_photos'].includes(script ?? '')) throw new Error('This link is missing a piece. Reopen the original handoff link.');
        const consumed = await fetchJson<{ photo_action_batch_id: string }>('/api/photo-migrations/handoffs/consume', 'That link did not work', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ token, script_name: script }),
        });
        batch = consumed.photo_action_batch_id;
        id.current = batch;
        window.history.replaceState(null, '', `${window.location.pathname}?batch=${encodeURIComponent(batch)}`);
      }
      if (batch) {
        id.current = batch;
        const next = await load(batch);
        if (next.can_mutate && next.batch.status === 'draft' && !next.batch.materialization_complete) await materialize(batch);
        return;
      }
      // One photo, and everything needed to ask the question: go straight to it.
      // A move still needs its project, so that case shows the project form first.
      if (chosenPhoto && (chosenAction !== 'move' || chosenDestination)) await start(chosenAction, chosenPhoto, chosenDestination);
    });
    // Initialization deliberately runs once, including React StrictMode replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, search]);

  const apply = async (approve: boolean) => {
    const batchId = id.current!;
    if (approve) await actionRequest(`batches/${batchId}/approve`, {});
    let page = 0;
    for (;;) {
      const current = await actionRequest<View>(`batches/${batchId}?offset=${page}&limit=${PAGE_SIZE}`);
      const targets = current.items.filter(item => ['pending', 'running', 'retryable_failed'].includes(item.status)).map(item => item.photo_id);
      if (targets.length) {
        await actionRequest(`batches/${batchId}/apply`, { photo_ids: targets });
        invalidatePhotoCaches(queryClient);
      }
      page += PAGE_SIZE;
      if (page >= current.total) break;
    }
    await load(batchId);
    heading.current?.focus();
  };
  const candidates = async (reference: Unresolved, page: number) => {
    const result = await actionRequest<{ candidates: Photo[]; total: number }>(`batches/${id.current}/candidates?reference_index=${reference.reference_index}&offset=${page}&limit=100`);
    setView(current => current && ({ ...current, unresolved: current.unresolved.map(item => item.reference_index === reference.reference_index ? { ...item, ...result } : item) }));
    setCandidateOffsets(current => ({ ...current, [reference.reference_index]: page }));
  };

  const owner = view?.can_mutate ?? false;
  const status = view?.batch.status;
  const terminal = status === 'completed' || status === 'cancelled';
  const draft = status === 'draft';
  const destinationJob = view?.batch.destination_job ?? jobs?.find(job => job.id === (view?.batch.destination_job_id ?? destination));
  // Where the photos end up, in words. A restore with no destination goes back where it was.
  const destinationName = !view ? null
    : destinationJob ? jobLabel(destinationJob)
    : view.batch.destination_job_id ? 'the chosen project'
    : action === 'move' ? NO_PROJECT
    : action === 'restore' && view.total === 1 && view.items[0]?.photo ? restoredTo(view.items[0].photo)
    : null;
  const backHref = action === 'restore' ? '/photos/trash' : '/photos';
  const problems = view?.items.filter(item => ['conflict', 'retryable_failed'].includes(item.status)).length ?? 0;
  const applied = view?.items.filter(item => item.status === 'applied').length ?? 0;
  /** Cancel before anything was confirmed: withdraw the draft and go back where they came from. */
  const cancelDraft = async () => {
    await actionRequest(`batches/${id.current}`, { action: 'cancel' }, 'PATCH');
    if (window.history.length > 1) router.back(); else router.push(backHref);
  };
  const needsProject = !view && !busy && ready && action === 'move' && Boolean(photoId) && !id.current;

  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 pb-40 sm:px-8">
    <nav aria-label="Back" className="-ml-2 flex flex-wrap gap-x-2">
      <Link href="/photos" className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-base font-medium text-[#8bbaff]"><span aria-hidden="true">&lsaquo;</span>DWS Photos</Link>
      <Link href="/photos/trash" className="flex min-h-11 items-center rounded-lg px-2 text-base font-medium text-[#8bbaff]">Trash</Link>
    </nav>
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">{pageTitle(action)}</h1>

    {error && <p role="alert" className={actionAlert}>{error}</p>}
    <p role="status" className="text-base text-[#bbb] empty:hidden">{busy ? message || 'One moment…' : message}</p>

    {!view && !busy && !photoId && ready && !error && <section className="max-w-xl space-y-3 rounded-xl bg-[#2e2e2e] p-5 text-base">
      <p>Nothing is selected.</p>
      <p className="text-[#bbb]">Open a photo and choose Set project or Move to trash, or select several photos first.</p>
      <Link href="/photos" className={`${primary} ${tall} inline-flex items-center`}>Go to Photos</Link>
    </section>}

    {/* A move that does not yet say where to. */}
    {needsProject && <section className="max-w-xl space-y-4 rounded-xl bg-[#2e2e2e] p-5">
      <label className="block space-y-2 text-base font-medium">Which project should this photo belong to?
        <select aria-label="Project" value={destination} onChange={event => setDestination(event.target.value)} className={`${field} ${tall}`} disabled={busy}>
          <option value="">Choose a project</option>
          <option value={NO_PROJECT_VALUE}>{NO_PROJECT}</option>
          {(jobs ?? []).map(job => <option key={job.id} value={job.id}>#{job.job_number} · {job.name}</option>)}
        </select></label>
      {creatingJob
        ? <NewJobForm jobs={jobs ?? []} onCancel={() => setCreatingJob(false)} onDone={job => { setDestination(job.id); setCreatingJob(false); }} />
        : <button type="button" className="flex min-h-11 items-center text-base text-[#8bbaff] underline" onClick={() => setCreatingJob(true)}>New project</button>}
      <p className="text-sm text-[#bbb]">Next you will see the photo and confirm. Nothing changes until then.</p>
      <div className="flex flex-wrap gap-3">
        <button className={`${primary} ${tall}`} disabled={busy || !destination} onClick={() => void act(() => start(action, photoId, destination))}>Continue</button>
        <Link href={backHref} className={`${button} ${tall} inline-flex items-center`}>Cancel</Link>
      </div>
    </section>}

    {view && <>
      {/* A reference the app could not pin to one photo (assistant hand-offs only). */}
      {view.unresolved.map(reference => <section key={reference.reference_index} className="space-y-3 rounded-xl border border-amber-700 bg-[#2e2e2e] p-4">
        <h2 className="text-lg font-semibold">{reference.reason === 'ambiguous' ? 'Choose the matching photo' : 'We could not find this photo'}</h2>
        <p className="break-all text-base text-[#bbb]">{'job_number' in reference.reference ? `Project #${reference.reference.job_number} · ${reference.reference.original_filename}` : 'photo_url' in reference.reference ? 'The photo from the link you were given' : 'The selected photo'}
          {reference.reason === 'ambiguous' ? ' — more than one photo matches. Pick the one you mean.' : ' — it may have been removed. You can leave it out and carry on.'}</p>
        {reference.candidates.map(photo => <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#555] p-3" key={photo.id}><ActionThumbnail photo={photo} /><span className="min-w-0 flex-1 break-all text-base">{label(photo)} · {projectName(photo.job, photo.job_id)}{!photo.deleted_at && <Link href={photoPath(photo.job_id, photo.id)} target="_blank" rel="noopener noreferrer" className="mt-1 block w-fit text-[#8bbaff] underline">View photo in new tab</Link>}</span><button className={`${button} ${tall}`} disabled={busy || !owner} onClick={() => void act(() => materialize(id.current!, { [reference.reference_index]: photo.id }))}>Choose this photo</button></div>)}
        <div className="flex flex-wrap gap-2">
          {reference.total > reference.candidates.length && <><button className={`${button} ${tall}`} disabled={busy || !(candidateOffsets[reference.reference_index] ?? 0)} onClick={() => void act(() => candidates(reference, Math.max(0, (candidateOffsets[reference.reference_index] ?? 0) - 100)))}>Earlier matches</button><button className={`${button} ${tall}`} disabled={busy || (candidateOffsets[reference.reference_index] ?? 0) + reference.candidates.length >= reference.total} onClick={() => void act(() => candidates(reference, (candidateOffsets[reference.reference_index] ?? 0) + 100))}>More matches</button></>}
          <button className={`${button} ${tall}`} disabled={busy || !owner} onClick={() => void act(() => materialize(id.current!, { [reference.reference_index]: null }))}>Leave this one out</button>
        </div>
      </section>)}

      {/* The photos first. A long list scrolls inside its own frame, so the question and its buttons stay close. */}
      <section aria-label="Photos" className="space-y-2">
        <p data-testid="action-count" className="text-base text-[#bbb]">{plural(view.total, 'photo')}</p>
        {/* Rows on a phone (a name and a project need the width), cards from there up. */}
        <div className="grid max-h-[42dvh] grid-cols-1 gap-2 overflow-y-auto overscroll-contain rounded-xl sm:max-h-[52dvh] sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-6">
          {view.items.map(item => {
            const trouble = item.status === 'conflict' || item.status === 'retryable_failed';
            return <article data-testid="action-item" key={item.photo_id} className={`flex gap-3 rounded-xl border bg-[#2e2e2e] p-2.5 sm:block sm:space-y-2 ${trouble ? 'border-amber-600' : 'border-[#444]'}`}>
              <div className="w-20 shrink-0 sm:w-auto"><ActionThumbnail photo={item.photo} fill /></div>
              <div className="min-w-0 flex-1 space-y-1">
              <h3 className="line-clamp-2 break-all text-sm font-medium" title={label(item.photo)}>{label(item.photo)}</h3>
              <p className="line-clamp-2 text-sm text-[#bbb]">{item.expected_deleted_at ? 'In Trash' : 'In Photos'} · {item.expected_job_id === null ? NO_PROJECT : item.photo?.job && item.photo.job.id === item.expected_job_id ? jobLabel(item.photo.job) : jobs?.find(job => job.id === item.expected_job_id)?.name ?? 'a project'}</p>
              {ITEM_STATUS[item.status] && <p className={`text-sm font-medium ${item.status === 'applied' ? 'text-green-400' : trouble ? 'text-amber-300' : 'text-[#bbb]'}`}>{ITEM_STATUS[item.status]}</p>}
              {item.photo?.purge_after && action === 'restore' && !terminal && <p className="text-sm text-amber-300">Restore before {new Date(item.photo.purge_after).toLocaleDateString()}.</p>}
              {item.requested_photo_id && item.requested_photo_id !== item.photo_id && <p className="text-sm text-[#bbb]">This is a copy of another photo. The change is made to the original shown here, so there is never a second copy.</p>}
              {/* Only when it has actually happened. */}
              {item.status === 'conflict' && <p className="text-sm text-amber-200">Someone changed this photo after this page opened — it was moved, trashed, or restored. Nothing was done to it. Try it again, or leave it out.</p>}
              {item.status === 'retryable_failed' && <p className="text-sm text-amber-200">Something went wrong with this one. Choose Try again below.</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {item.photo && !item.photo.deleted_at && <Link className="flex min-h-11 items-center text-[#8bbaff] underline" href={photoPath(item.photo.job_id, item.photo_id)}>View photo</Link>}
                {item.status === 'conflict' && <Link className="flex min-h-11 items-center text-[#8bbaff] underline" href={`/photos/actions?action=${action}&photo=${item.photo_id}${view.batch.destination_job_id ? `&destination=${view.batch.destination_job_id}` : action === 'move' ? `&destination=${NO_PROJECT_VALUE}` : ''}`}>Try this photo again</Link>}
                {owner && !terminal && trouble && <button className="flex min-h-11 items-center text-[#8bbaff] underline" disabled={busy} onClick={() => void act(async () => { await actionRequest(`batches/${id.current}`, { action: 'skip', photo_ids: [item.photo_id] }, 'PATCH'); await load(id.current!, offset); })}>Leave it out</button>}
                {item.status === 'applied' && action === 'trash' && <Link className="flex min-h-11 items-center text-[#8bbaff] underline" href={`/photos/actions?action=restore&photo=${item.photo_id}`}>Undo: restore it</Link>}
              </div>
              </div>
            </article>;
          })}
        </div>
        {view.total > PAGE_SIZE && <div className="flex flex-wrap items-center gap-3"><button className={`${button} ${tall}`} disabled={busy || !offset} onClick={() => void act(async () => { await load(id.current!, Math.max(0, offset - PAGE_SIZE)); })}>Earlier photos</button><span className="text-sm text-[#bbb]">{offset + 1}–{Math.min(offset + view.items.length, view.total)} of {view.total}</span><button className={`${button} ${tall}`} disabled={busy || offset + PAGE_SIZE >= view.total} onClick={() => void act(async () => { await load(id.current!, offset + PAGE_SIZE); })}>More photos</button></div>}
      </section>

      {/* Then the one question, the verb, and Cancel. */}
      <section className="space-y-3 rounded-xl bg-[#2e2e2e] p-5">
        {/* Before confirming, the question below says it all; the status is for afterwards. */}
        <p data-testid="action-status" className={draft ? 'sr-only' : 'text-sm text-[#bbb]'}>{BATCH_STATUS[view.batch.status]}</p>
        {draft && <>
          <p data-testid="action-question" className="break-words text-xl font-semibold">{question(action, view.total, destinationName)}</p>
          {action === 'trash' && <p className="text-base leading-relaxed text-[#ddd]">{trashDisclosure}</p>}
          {action === 'move' && <p className="text-base text-[#bbb]">{destinationName === NO_PROJECT ? 'They stay in Photos and in their albums. They just belong to no project.' : 'Nothing else changes: the photos keep their albums and tags.'}</p>}
          {action === 'restore' && <p className="text-base text-[#bbb]">The photo goes back to Photos, with the albums and tags it had.</p>}
          {!view.batch.materialization_complete && view.unresolved.length > 0 && <p className="text-base text-amber-300">Answer the question above first.</p>}
          {view.batch.materialization_complete && view.total === 0 && <p className="text-base text-amber-300">There is no photo left to change here.</p>}
        </>}
        {status === 'completed' && <p data-testid="action-question" className="break-words text-xl font-semibold text-green-400">Done. {outcome(action, view.total <= PAGE_SIZE ? applied : null, destinationName)}</p>}
        {status === 'completed' && action === 'trash' && <p className="text-base leading-relaxed text-[#ddd]">{trashDisclosure}</p>}
        {status === 'completed' && fromUpload && <p className="text-base text-[#bbb]">Your upload was waiting for this. Go back to it and choose Check again.</p>}
        {status === 'cancelled' && <p className="text-xl font-semibold">{applied ? 'Stopped. The photos marked Done were already changed; nothing else will change.' : 'Cancelled. Nothing was changed.'}</p>}
        {!draft && !terminal && <p className="text-xl font-semibold">{problems ? `${plural(problems, 'photo')} still ${problems === 1 ? 'needs' : 'need'} another look.` : 'Not finished yet.'}</p>}
        {!owner && <p className="text-base text-amber-300">Someone else started this. You can look, but only they can confirm it.</p>}
        <div className="flex flex-wrap gap-3">
          {draft && <button className={`${action === 'trash' ? danger : primary} ${tall}`} disabled={busy || !owner || !view.batch.materialization_complete || !view.total || !!view.unresolved.length} onClick={() => void act(() => apply(true))}>{verb(action, view.total)}</button>}
          {!terminal && !draft && <button className={`${primary} ${tall}`} disabled={busy || !owner} onClick={() => void act(() => apply(false))}>Try again</button>}
          {draft && (owner
            ? <button className={`${button} ${tall}`} disabled={busy} onClick={() => void act(cancelDraft)}>Cancel</button>
            : <Link href={backHref} className={`${button} ${tall} inline-flex items-center`}>Back</Link>)}
          {!terminal && !draft && <button className={`${button} ${tall}`} disabled={busy || !owner} onClick={() => void act(async () => { await actionRequest(`batches/${id.current}`, { action: 'cancel' }, 'PATCH'); await load(id.current!); })}>Stop here</button>}
          {terminal && <Link href={backHref} className={`${primary} ${tall} inline-flex items-center`}>{action === 'restore' ? 'Back to Trash' : 'Back to Photos'}</Link>}
          {status === 'completed' && action === 'trash' && <Link href="/photos/trash" className={`${button} ${tall} inline-flex items-center`}>Open Trash</Link>}
          {!draft && <button className={`${button} ${tall}`} disabled={busy} onClick={() => void act(async () => { await load(id.current!, offset); invalidatePhotoCaches(queryClient); })}>Refresh</button>}
        </div>
      </section>
    </>}
  </div>;
}
