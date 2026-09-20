'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { fetchJson, invalidatePhotoCaches, usePhotoJobs } from '@/lib/photos/api';
import { actionRequest, actionButton as button, actionPrimary as primary, actionField as field, trashDisclosure } from '@/lib/photos/action-client';
import ActionThumbnail from '@/components/photos/action-thumbnail';

import type { PhotoAction as Action, ActionPhoto as Photo, UnresolvedPhotoReference as Unresolved, PhotoActionBatchResponse as View } from '@/lib/photos/action-types';
import NewJobForm from '@/components/photos/new-job-form';
const PAGE_SIZE = 50;
const title = (action: Action) => action === 'trash' ? 'Move photos to trash' : action === 'restore' ? 'Restore photos' : 'Move photos';
const label = (photo: Photo | null) => photo?.original_name || 'Photo';

export default function PhotoActions() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View | null>(null);
  const [action, setAction] = useState<Action>('move');
  const [photoId, setPhotoId] = useState('');
  const [destination, setDestination] = useState('');
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

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'Photo action failed. Retry when connected.');
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const load = useCallback(async (batchId: string, page = 0) => {
    const next = await actionRequest<View>(`batches/${batchId}?offset=${page}&limit=${PAGE_SIZE}`);
    setView(next); setAction(next.batch.action); setOffset(page); setCandidateOffsets({});
    return next;
  }, []);
  const materialize = async (batchId: string, choices?: Record<number, string | null>) => {
    let next: View;
    do {
      next = await actionRequest<View>(`batches/${batchId}/materialize`, choices ? { choices } : {});
      choices = undefined;
      setView(next); setMessage(`${next.total} exact ${next.total === 1 ? 'target' : 'targets'} prepared.`);
    } while (!next.batch.materialization_complete && !next.unresolved.length);
    await load(batchId); heading.current?.focus();
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
      if (chosen === 'move' || chosen === 'trash' || chosen === 'restore') setAction(chosen);
      setPhotoId(params.get('photo') ?? ''); setDestination(params.get('destination') ?? '');
      let batch = params.get('batch');
      const token = params.get('token');
      if (token) {
        const script = params.get('script_name');
        if (!['move_photos', 'remove_photos', 'restore_photos'].includes(script ?? '')) throw new Error('This photo handoff is missing its action. Reopen the original handoff link.');
        const consumed = await fetchJson<{ photo_action_batch_id: string }>('/api/photo-migrations/handoffs/consume', 'Handoff failed', {
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
      }
    });
    // Initialization deliberately runs once, including React StrictMode replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, search]);

  const review = async () => {
    if (!photoId) throw new Error('Open an action from a photo, the trash, or an MCP handoff.');
    const created = await actionRequest<{ batch: View['batch'] }>('batches', { action, selector: { photos: [{ photo_id: photoId }] }, ...(destination ? { destination_job_id: destination } : {}) });
    id.current = created.batch.id;
    window.history.replaceState(null, '', `${window.location.pathname}?batch=${created.batch.id}`);
    await materialize(created.batch.id);
  };
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
    const next = await load(batchId);
    setMessage(next.batch.status === 'completed' ? 'Confirmed actions complete. Return to your upload and choose Check again or Retry if it was waiting for this photo.' : 'Some targets still need attention. Review each result below; changed targets require a new confirmation.');
    heading.current?.focus();
  };
  const candidates = async (reference: Unresolved, page: number) => {
    const result = await actionRequest<{ candidates: Photo[]; total: number }>(`batches/${id.current}/candidates?reference_index=${reference.reference_index}&offset=${page}&limit=100`);
    setView(current => current && ({ ...current, unresolved: current.unresolved.map(item => item.reference_index === reference.reference_index ? { ...item, ...result } : item) }));
    setCandidateOffsets(current => ({ ...current, [reference.reference_index]: page }));
  };
  const owner = view?.can_mutate ?? false;
  const terminal = view && ['completed', 'cancelled'].includes(view.batch.status);
  const destinationJob = view?.batch.destination_job ?? jobs?.find(job => job.id === (view?.batch.destination_job_id ?? destination));

  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 pb-40 sm:px-8">
    <nav className="flex gap-5 text-sm text-[#8bbaff]"><Link href="/photos">DWS Photos</Link><Link href="/photos/trash">Trash</Link></nav>
    <header className="space-y-3"><h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">{title(action)}</h1>
      <p className="max-w-3xl text-sm leading-6 text-[#bbb]">Review the exact photos and their current jobs before confirming. Photos added to a job later are outside this list. Concurrent changes appear as individual conflicts.</p>
      {(action === 'trash' || action === 'restore') && <p className="rounded-lg border border-[#555] bg-[#2e2e2e] p-4 text-sm leading-6 text-[#ddd]">{trashDisclosure}</p>}
      {action === 'restore' && <p className="text-sm text-[#bbb]">An ordinary restore requires the uploader or an administrator. Ask an administrator to restore this photo, or use the MCP restore handoff. A legacy duplicate redirects to its canonical photo; restoring it never creates a second active copy.</p>}
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">{error}</p>}
    <p role="status" className="text-sm text-[#bbb]">{busy ? message || 'Working…' : message}</p>
    {!view && <section className="max-w-xl space-y-4 rounded-xl bg-[#2e2e2e] p-4">
      <p className="break-all text-sm text-[#bbb]">{photoId ? 'A photo is selected. Review it below before confirming.' : 'No photo selected'}</p>
      {action !== 'trash' && <label className="block space-y-2 text-sm">{action === 'restore' ? 'Restore destination (optional)' : 'Destination job'}<select aria-label="Destination job" value={destination} onChange={event => setDestination(event.target.value)} className={field} disabled={busy}>
        <option value="">{action === 'restore' ? 'Keep the current owning job' : 'Choose a job'}</option>
        {(jobs ?? []).map(job => <option key={job.id} value={job.id}>{job.job_number} · {job.name}</option>)}
      </select></label>}
      {action !== 'trash' && !busy && (creatingJob
        ? <NewJobForm jobs={jobs ?? []} onCancel={() => setCreatingJob(false)} onDone={job => { setDestination(job.id); setCreatingJob(false); }} />
        : <button type="button" className="block text-xs text-[#8bbaff] underline" onClick={() => setCreatingJob(true)}>New project</button>)}
      <button className={primary} disabled={!ready || busy || !photoId || (action === 'move' && !destination)} onClick={() => void act(review)}>Review exact targets</button>
    </section>}
    {view && <>
      <section className="space-y-3 rounded-xl bg-[#2e2e2e] p-4">
        <p data-testid="action-status" className="text-sm">Status: <strong className={view.batch.status === 'completed' ? 'text-green-400' : 'text-[#8bbaff]'}>{view.batch.status}</strong></p>
        <p data-testid="action-count" className="text-lg font-semibold">{view.total.toLocaleString()} exact {view.total === 1 ? 'target' : 'targets'}</p>
        <p className="text-sm">{action === 'trash' ? 'Outcome: recoverable trash' : `Destination: ${destinationJob ? `${destinationJob.job_number} · ${destinationJob.name}` : view.batch.destination_job_id ? 'Selected job' : 'each photo’s current owning job'}`}</p>
        {!owner && <p className="text-sm text-amber-300">You can inspect this batch. Only its creator or bound handoff consumer can confirm or change it.</p>}
        {view.batch.status === 'draft' && <p className="text-sm text-[#bbb]">{view.batch.materialization_complete ? 'Only the photos shown below will change.' : 'Resolve the references below before confirming.'}</p>}
        <div className="flex flex-wrap gap-3">
          {view.batch.status === 'draft' && <button className={primary} disabled={busy || !owner || !view.batch.materialization_complete || !view.total || !!view.unresolved.length} onClick={() => void act(() => apply(true))}>Confirm {action === 'trash' ? 'move to trash' : action}</button>}
          {!terminal && view.batch.status !== 'draft' && <button className={primary} disabled={busy || !owner} onClick={() => void act(() => apply(false))}>Retry unfinished targets</button>}
          {!terminal && <button className={button} disabled={busy || !owner} onClick={() => void act(async () => { await actionRequest(`batches/${id.current}`, { action: 'cancel' }, 'PATCH'); await load(id.current!); })}>Cancel pending actions</button>}
          <button className={button} disabled={busy} onClick={() => void act(async () => { await load(id.current!, offset); invalidatePhotoCaches(queryClient); })}>Refresh results</button>
        </div>
      </section>
      {view.unresolved.map(reference => <section key={reference.reference_index} className="space-y-3 rounded-xl border border-amber-700 bg-[#2e2e2e] p-4">
        <h2 className="font-semibold">Reference {reference.reference_index + 1}: {reference.reason === 'ambiguous' ? 'Choose the matching photo' : 'No matching photo found'}</h2>
        <p className="break-all text-sm text-[#bbb]">{'job_number' in reference.reference ? `Job ${reference.reference.job_number} · ${reference.reference.original_filename}` : 'photo_url' in reference.reference ? 'Photo from the supplied link' : 'Selected photo'}</p>
        {reference.candidates.map(photo => <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#555] p-3" key={photo.id}><ActionThumbnail photo={photo} /><span className="min-w-0 flex-1 break-all text-sm">{label(photo)} · Job {photo.job?.job_number ?? 'unavailable'}{!photo.deleted_at && <Link href={`/photos/${photo.job_id}?photo=${photo.id}`} target="_blank" rel="noopener noreferrer" className="mt-1 block w-fit text-[#8bbaff] underline">View photo in new tab</Link>}</span><button className={button} disabled={busy || !owner} onClick={() => void act(() => materialize(id.current!, { [reference.reference_index]: photo.id }))}>Choose this photo</button></div>)}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !(candidateOffsets[reference.reference_index] ?? 0)} onClick={() => void act(() => candidates(reference, Math.max(0, (candidateOffsets[reference.reference_index] ?? 0) - 100)))}>Previous matches</button><button className={button} disabled={busy || (candidateOffsets[reference.reference_index] ?? 0) + reference.candidates.length >= reference.total} onClick={() => void act(() => candidates(reference, (candidateOffsets[reference.reference_index] ?? 0) + 100))}>Next matches</button><button className={button} disabled={busy || !owner} onClick={() => void act(() => materialize(id.current!, { [reference.reference_index]: null }))}>Skip unresolved reference</button></div>
      </section>)}
      <section className="space-y-3"><h2 className="font-semibold">Exact target list <span className="text-sm font-normal text-[#aaa]">· {PAGE_SIZE} per page</span></h2>
        {view.items.map(item => <article data-testid="action-item" key={item.photo_id} className="space-y-2 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
          <div className="flex items-start gap-3"><ActionThumbnail photo={item.photo} /><div className="min-w-0 flex-1"><h3 className="break-all font-medium">{label(item.photo)}</h3><span className={`text-sm ${item.status === 'applied' ? 'text-green-400' : item.status === 'conflict' ? 'text-amber-300' : 'text-[#bbb]'}`}>{item.status.replaceAll('_', ' ')}</span></div></div>
          <p className="break-all text-sm text-[#bbb]">Expected job: {jobs?.find(job => job.id === item.expected_job_id)?.job_number ?? 'unavailable'} · {item.expected_deleted_at ? 'In trash' : 'Active'}</p>
          {item.photo?.purge_after && <p className="text-sm text-amber-300">Restore before {new Date(item.photo.purge_after).toLocaleString()}.</p>}
          {item.requested_photo_id && item.requested_photo_id !== item.photo_id && <p className="text-sm text-amber-300">This legacy duplicate points to the canonical photo shown here. The action changes that canonical photo and preserves one active copy.</p>}
          {item.error && <p className="text-sm text-amber-300">{String(item.error.code ?? 'This photo changed. Start a new action to review its current state.')}</p>}
          {item.status === 'conflict' && <p className="text-sm text-[#bbb]">The confirmed state no longer matches. Skip this target or open a new action and confirm its current state.</p>}
          <div className="flex flex-wrap gap-3 text-sm">
            {item.photo && !item.photo.deleted_at && <Link className="text-[#8bbaff] underline" href={`/photos/${item.photo.job_id}?photo=${item.photo_id}`}>View photo</Link>}
            {owner && !terminal && ['conflict', 'retryable_failed'].includes(item.status) && <button className={button} disabled={busy} onClick={() => void act(async () => { await actionRequest(`batches/${id.current}`, { action: 'skip', photo_ids: [item.photo_id] }, 'PATCH'); await load(id.current!, offset); })}>Skip this target</button>}
            {item.status === 'conflict' && <Link className="text-[#8bbaff] underline" href={`/photos/actions?action=${action}&photo=${item.photo_id}${view.batch.destination_job_id ? `&destination=${view.batch.destination_job_id}` : ''}`}>Review new action</Link>}
            {item.status === 'applied' && action === 'trash' && <Link className="text-[#8bbaff] underline" href={`/photos/actions?action=restore&photo=${item.photo_id}`}>Review restore</Link>}
          </div>
        </article>)}
        <div className="flex items-center gap-3"><button className={button} disabled={busy || !offset} onClick={() => void act(async () => { await load(id.current!, Math.max(0, offset - PAGE_SIZE)); })}>Previous targets</button><span className="text-xs text-[#bbb]">{view.total ? offset + 1 : 0}–{Math.min(offset + view.items.length, view.total)} of {view.total}</span><button className={button} disabled={busy || offset + PAGE_SIZE >= view.total} onClick={() => void act(async () => { await load(id.current!, offset + PAGE_SIZE); })}>Next targets</button></div>
      </section>
    </>}
  </div>;
}
