'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { invalidatePhotoCaches } from '@/lib/photos/api';
import SheetShell from '@/components/photos/sheet-shell';
import { supabase } from '@/lib/supabaseClient';
import { buildBrowserUploadDeps } from '@/lib/photos/upload-browser';
import { createUploadRequest } from '@/lib/photos/upload-http';
import type { UploadAttempt } from '@/lib/photos/upload-contract';
import { MigrationEngine } from '@/lib/photos/migration/engine';
import { directorySource, filesSource, inventoryChunks, type DirectoryHandle, type LocalSource } from '@/lib/photos/migration/inventory';
import { createMigrationRequest, isPausedMigrationItem, migrationItemStatusLabel, retryDue, type BatchView, type ItemPage, type MigrationBatch, type MigrationItem, type MigrationSource } from '@/lib/photos/migration/client';

const button = 'rounded-lg border border-[#555] px-4 py-2 text-sm font-medium hover:bg-[#444] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2680FC] disabled:opacity-40';
const primary = `${button} border-transparent bg-[#2680FC] text-white hover:bg-[#1a6fd8]`;
const field = 'w-full rounded-lg border border-[#555] bg-[#222222] px-3 py-2 text-sm text-white focus:outline-2 focus:outline-[#2680FC]';
const bytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n.toLocaleString()} bytes`;
type Job = { id: string; job_number?: string; number?: string; name?: string; job_name?: string };
const refreshAuth = async () => { const { data, error } = await supabase.auth.refreshSession(); return !error && !!data.session; };

export default function MigratePage() {
  const queryClient = useQueryClient();
  const [request] = useState(() => createMigrationRequest(refreshAuth));
  const [view, setView] = useState<BatchView | null>(null);
  const [sources, setSources] = useState<MigrationSource[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobQuery, setJobQuery] = useState('');
  const [recent, setRecent] = useState<MigrationBatch[]>([]);
  const [items, setItems] = useState<ItemPage>({ items: [], next_cursor: null });
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourcePage, setSourcePage] = useState(0);
  const [mode, setMode] = useState<'migrate_photos' | 'add_photos'>('migrate_photos');
  const [compactOpen, setCompactOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');
  const [sheet, setSheet] = useState('');
  const [tags, setTags] = useState('');
  const [progress, setProgress] = useState<Record<string, [number, number]>>({});
  const [selectedVersion, setSelectedVersion] = useState(0);
  const localSources = useRef(new Map<string, LocalSource>());
  const reviewedSources = useRef(new Set<string>());
  const engine = useRef<MigrationEngine | null>(null);
  const batchId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const compactReview = useRef<HTMLDivElement>(null);
  const starting = useRef(false);
  const initStarted = useRef(false);
  const scanning = useRef<AbortController | null>(null);
  const fileReselect = useRef<string | null>(null);

  const refresh = useCallback(async (id = batchId.current, after: string | null = null) => {
    if (!id) return;
    const [nextView, nextSources, nextItems] = await Promise.all([
      request<BatchView>(`batches/${id}`), (async () => {
        const all: MigrationSource[] = []; let sourceCursor: string | null = null;
        do {
          const page: { sources: MigrationSource[]; next_cursor: string | null } = await request(`batches/${id}/sources?limit=100${sourceCursor ? `&after=${encodeURIComponent(sourceCursor)}` : ''}`);
          all.push(...page.sources); sourceCursor = page.next_cursor;
        } while (sourceCursor);
        return { sources: all };
      })(),
      request<ItemPage>(`batches/${id}/items?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`),
    ]);
    setView(nextView); setSources(nextSources.sources); setItems(nextItems);
    setMode(nextView.batch.script_name);
    if (nextView.batch.script_name === 'add_photos') {
      const rules = nextSources.sources[0]?.selection_rules;
      setSheet(typeof rules?.sheet_number === 'string' ? rules.sheet_number : nextView.batch.requested_input?.sheet_number ?? '');
      setTags(Array.isArray(rules?.tags) ? (rules.tags as string[]).join(', ') : nextView.batch.requested_input?.tags?.join(', ') ?? '');
    }
    return nextView;
  }, [request]);

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'Migration failed. Please retry.');
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    void act(async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) { window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      setUserId(data.user.id);
      const params = new URLSearchParams(window.location.search);
      const script = params.get('script_name') ?? params.get('script') ?? params.get('mode');
      const chosenMode = script === 'add_photos' ? 'add_photos' : 'migrate_photos';
      setMode(chosenMode); setCompactOpen(chosenMode === 'add_photos');
      let id = params.get('batch');
      const token = params.get('token');
      if (token) {
        if (!['migrate_photos', 'add_photos'].includes(params.get('script_name') ?? '')) {
          throw new Error('This photo handoff is missing its action. Reopen the original handoff link.');
        }
        const consumed = await request<{ migration_batch_id: string }>('handoffs/consume', { token, script_name: chosenMode });
        id = consumed.migration_batch_id;
        window.history.replaceState(null, '', `/migrate?batch=${encodeURIComponent(id)}`);
      }
      if (id) {
        batchId.current = id;
        const loaded = await refresh(id);
        if (loaded?.batch.script_name === 'add_photos' && loaded.batch.status === 'draft') setCompactOpen(true);
        setMessage('Reselect each source to check its files before resuming. Completed uploads are preserved.');
      }
      const batches = await request<{ batches: MigrationBatch[] }>('batches'); setRecent(batches.batches);
    });
  }, [refresh, request]);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request<{ jobs: Job[] }>(`jobs?q=${encodeURIComponent(jobQuery)}`, undefined, { signal: controller.signal })
        .then(result => setJobs(result.jobs)).catch(reason => { if (!controller.signal.aborted) report(reason); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [request, jobQuery, userId]);

  useEffect(() => () => { engine.current?.stop(); scanning.current?.abort(); }, []);
  useEffect(() => {
    if (!view || view.batch.status === 'draft') return;
    const timer = setInterval(() => { if (!busy && !running) void refresh(batchId.current, cursor).catch(report); }, 5000);
    return () => clearInterval(timer);
  }, [view?.batch.status, refresh, busy, running, cursor]);

  const ensureBatch = async () => {
    if (batchId.current) return batchId.current;
    const { batch } = await request<{ batch: MigrationBatch }>('batches', { script_name: mode });
    batchId.current = batch.id;
    window.history.replaceState(null, '', `/migrate?batch=${batch.id}`);
    setView({ batch, can_mutate: true, counts: {} });
    return batch.id;
  };

  const addLocal = (local: LocalSource, existing?: MigrationSource) => {
    const id = existing?.id ?? crypto.randomUUID();
    localSources.current.set(id, local); setSelectedVersion(version => version + 1);
    reviewedSources.current.delete(id);
    if (!existing) {
      const hint = view?.batch.requested_input;
      const jobNumber = mode === 'add_photos' ? hint?.job_number : hint?.sources?.find(source => source.label === local.label)?.job_number;
      const jobId = jobs.find(job => String(job.job_number ?? job.number) === jobNumber)?.id ?? '';
      setSources(current => [...current, { id, label: local.label, kind: local.kind, job_id: jobId, batch_id: batchId.current ?? '' }]);
    }
    setMessage('Source selected. Review files to save its inventory and check for changes.');
  };

  const selectDirectory = async (existing?: MigrationSource) => {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error('Folder selection requires Chrome or Edge on a computer. Use Add photos for a file selection.');
    const handle = await picker({ mode: 'read' });
    addLocal(directorySource(handle), existing);
  };

  const scan = async () => {
    const id = await ensureBatch();
    const controller = new AbortController(); scanning.current = controller;
    try {
      for (const source of sources) {
        const local = localSources.current.get(source.id);
        if (!local) throw new Error(`Reselect ${source.label} before reviewing its inventory.`);
        if (!source.job_id) throw new Error(`Choose a destination job for ${source.label}.`);
        if (!view || view.batch.status === 'draft') {
          await request(`batches/${id}/sources`, { id: source.id, job_id: source.job_id, kind: source.kind, label: source.label,
            selection_rules: { sheet_number: sheet, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) } }, { signal: controller.signal });
        }
        const scanId = crypto.randomUUID();
        await request(`sources/${source.id}/scan`, { scan_id: scanId }, { signal: controller.signal });
        let chunkNumber = 0, totalEntries = 0, totalBytes = 0;
        const digests: string[] = [];
        for await (const entries of inventoryChunks(local.entries(controller.signal), (entries, chunk_number) => ({ scan_id: scanId, chunk_number, entries }))) {
          const chunk = await request<{ payload_digest: string; entry_count: number; total_bytes: number }>(`sources/${source.id}/chunks`, { scan_id: scanId, chunk_number: chunkNumber++, entries }, { signal: controller.signal });
          digests.push(chunk.payload_digest); totalEntries += chunk.entry_count; totalBytes += chunk.total_bytes;
          setMessage(`Scanning ${source.label}: ${chunkNumber.toLocaleString()} inventory chunks saved.`);
        }
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digests.join('')));
        const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
        await request(`sources/${source.id}/seal`, { scan_id: scanId, chunk_count: chunkNumber,
          total_entries: totalEntries, total_bytes: totalBytes, job_id: source.job_id, fingerprint }, { signal: controller.signal });
        reviewedSources.current.add(source.id);
      }
      await refresh(id); setCursor(null);
      setMessage('Inventory saved. Review source mappings, totals, exclusions and warnings below.');
      (compactOpen ? compactReview.current : heading.current)?.focus();
    } finally { scanning.current = null; }
  };

  const makeEngine = (id: string) => {
    const uploadRequest = createUploadRequest({ refreshAuth });
    return new MigrationEngine({ batchId: id, uploaderId: userId, sources,
      localSources: localSources.current, request, deps: buildBrowserUploadDeps(),
      prepare: (input, options) => uploadRequest<UploadAttempt>('prepare', input, options),
      meta: { sheetNumber: sheet, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) },
      onChange: async completedItemId => {
        invalidatePhotoCaches(queryClient);
        setProgress(current => {
          if (!completedItemId) return {};
          const next = { ...current }; delete next[completedItemId]; return next;
        });
        await refresh(id);
      },
      onProgress: (itemId, sent, total) => setProgress(current => ({ ...current, [itemId]: [sent, total] })),
    });
  };

  const retryXmp = async (item: MigrationItem) => {
    const worker = makeEngine(batchId.current!); engine.current = worker;
    setRunning(true);
    try {
      const result = await worker.upload(item);
      if (!['done', 'duplicate'].includes(result.status)) throw new Error(result.error ?? 'This original is no longer eligible for XMP attachment.');
      setMessage(result.sidecarRetry ? 'XMP attachment still needs attention. Reselect the original and sidecar to retry.' : 'XMP attachment checked. The existing original was preserved.');
    } finally { engine.current = null; setRunning(false); await refresh(); }
  };

  const start = async (approve: boolean) => {
    if (starting.current || engine.current) return;
    starting.current = true;
    const id = batchId.current!;
    try {
      if (sources.some(source => !reviewedSources.current.has(source.id))) throw new Error('Reselect every source and review files before starting.');
      if (approve) await request(`batches/${id}`, { action: 'approve' }, { method: 'PATCH' });
      await request(`batches/${id}`, { action: 'resume' }, { method: 'PATCH' });
    } catch (reason) { starting.current = false; throw reason; }
    setCompactOpen(false); setRunning(true); setProgress({}); setError('');
    const worker = makeEngine(id);
    engine.current = worker;
    try { await worker.run(); }
    catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) report(reason);
    } finally { setRunning(false); starting.current = false; engine.current = null; await refresh(id); }
  };

  const stop = async (cancel: boolean) => {
    engine.current?.stop(); scanning.current?.abort();
    await request(`batches/${batchId.current}`, { action: cancel ? 'cancel' : 'pause' }, { method: 'PATCH' });
    await refresh(); setMessage(cancel ? 'Batch cancelled. Photos already committed remain in the library.' : 'Paused. Keep this page open, or reselect your sources when you return.');
  };

  const editable = !view || (view.can_mutate && view.batch.status === 'draft');
  const owner = view?.can_mutate ?? true;
  const sealed = sources.length > 0 && sources.every(source => source.sealed_scan_id && source.sealed_scan_id === source.scan_id);
  const totals = view?.counts ?? {};
  const byStatus = (totals.by_status ?? {}) as Record<string, number>;
  const selected = selectedVersion >= 0 && sources.every(source => localSources.current.has(source.id));
  const reviewed = sources.every(source => reviewedSources.current.has(source.id));
  const status = view?.batch.status ?? 'draft';
  const terminal = status === 'completed' || status === 'cancelled';
  const needsAttention = !running && ['running', 'approved'].includes(status) && (Boolean(error) || ['retryable_failed', 'job_conflict', 'restore_required'].some(state => Number(byStatus[state] ?? 0) > 0));
  const statusLabel = needsAttention ? 'Needs attention' : status;

  const fileInput = <label className="block space-y-2 text-sm">Select photos
    <input aria-label="Select photos" type="file" multiple className={field} disabled={busy || !owner}
      onChange={event => {
        if (!event.target.files?.length) return;
        const existing = sources.find(source => source.id === fileReselect.current) ?? (mode === 'add_photos' ? sources[0] : undefined);
        try { addLocal(filesSource(event.target.files), existing); } catch (reason) { report(reason); }
        fileReselect.current = null; event.target.value = '';
      }} />
    <span className="block text-xs text-[#aaa]">Choose up to 500 files. For larger selections, use Select folder on a computer.</span>
  </label>;

  const sourceRows = <div className="space-y-4">
    <label className="block text-sm text-[#bbb]">Find destination job
      <input aria-label="Find destination job" value={jobQuery} onChange={event => setJobQuery(event.target.value)} className={`${field} mt-1`} placeholder="Job number" disabled={!editable} />
    </label>
    {sources.slice(sourcePage * 20, sourcePage * 20 + 20).map(source => <div key={source.id} className="rounded-lg border border-[#484848] p-3" data-testid="migration-source">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><strong className="break-all text-sm">{source.label}</strong>
        <span className="text-xs text-[#bbb]">{localSources.current.has(source.id) ? 'Selected' : 'Reselection required'}</span></div>
      <label className="block text-xs text-[#bbb]">Destination job for {source.label}
        <select aria-label={`Destination job for ${source.label}`} className={`${field} mt-1`} value={source.job_id} disabled={!editable || busy}
          onChange={event => setSources(current => current.map(row => row.id === source.id ? { ...row, job_id: event.target.value, sealed_scan_id: null } : row))}>
          <option value="">Choose a job</option>
          {source.job_id && !jobs.some(job => job.id === source.job_id) && <option value={source.job_id}>{source.jobs ? `${source.jobs.job_number} · ${source.jobs.name}` : 'Selected destination'}</option>}
          {jobs.map(job => <option value={job.id} key={job.id}>{job.job_number ?? job.number} · {job.name ?? job.job_name}</option>)}
        </select>
      </label>
      {owner && !running && status !== 'cancelled' && <button className={`${button} mt-3`} onClick={() => source.kind === 'directory'
        ? void act(() => selectDirectory(source)) : (fileReselect.current = source.id, setCompactOpen(true))}>Reselect {source.label}</button>}
    </div>)}
    {sources.length > 20 && <div className="flex gap-2"><button className={button} disabled={sourcePage === 0} onClick={() => setSourcePage(page => page - 1)}>Previous sources</button><button className={button} disabled={(sourcePage + 1) * 20 >= sources.length} onClick={() => setSourcePage(page => page + 1)}>Next sources</button></div>}
  </div>;

  const counts = <div data-testid="batch-counts" className="space-y-2 text-sm">
    <p><strong>{Number(totals.total ?? 0).toLocaleString()}</strong> {Number(totals.total ?? 0) === 1 ? 'file' : 'files'} · <strong>{bytes(Number(totals.upload_bytes ?? totals.total_bytes ?? 0))}</strong> selected, including XMP · {sources.length} {sources.length === 1 ? 'source' : 'sources'}</p>
    <p>{Number(byStatus.completed ?? 0)} completed · {Number(byStatus.skipped_duplicate ?? 0)} duplicates · {Number(byStatus.skipped_unsupported ?? 0)} exclusions · {Number(totals.xmp ?? 0)} paired XMP</p>
    <p className="text-[#bbb]">Picasa internals, hidden/cache files, unsupported files and unmatched XMP are excluded. Ambiguous sidecars stay excluded with a warning.</p>
    {Object.entries((totals.exclusions_by_reason ?? {}) as Record<string, number>).map(([reason, count]) => <p key={reason}>{reason}: {count}</p>)}
  </div>;

  const approveButton = <button className={primary} disabled={busy || running || !owner || !sealed || !selected || !reviewed} onClick={() => void start(true).catch(report)}>Approve and start</button>;

  return <main className="h-dvh overflow-y-auto bg-[#222222] text-white">
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between gap-4"><Link className="text-sm text-[#2680FC]" href="/photos">DWS Photos</Link><span className="text-xs text-[#aaa]">Foreground migration</span></header>
      <section className="space-y-3"><h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">{mode === 'add_photos' ? 'Add photos' : 'Migrate photo folders'}</h1>
        <p className="max-w-3xl text-sm leading-6 text-[#bbb]">Choose folders and confirm a destination job for each source. Keep this page open while uploading. If you close it or lose drive permission, return to your saved batch and reselect the same folders. Completed photos appear in the library immediately.</p>
        <p data-testid="batch-status" className="text-sm">Status: <strong className={status === 'completed' ? 'text-green-400' : status === 'cancelled' || needsAttention ? 'text-amber-300' : 'text-[#73adff]'}>{statusLabel}</strong></p>
        {view && !owner && <p className="rounded-lg bg-[#2e2e2e] p-3 text-sm">You can inspect this batch. Only its creator can select sources, approve, resume or cancel it.</p>}
      </section>
      {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">{error}</p>}
      <p role="status" aria-live="polite" className="text-sm text-[#bbb]">{busy ? message || 'Working…' : message}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <section className="space-y-4 rounded-xl bg-[#2e2e2e] p-4"><h2 className="font-semibold">Sources and destinations</h2>
          {editable && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || mode === 'add_photos'} onClick={() => void act(() => selectDirectory())}>Select folder</button><button className={button} disabled={busy} onClick={() => { if (!sources.length) setMode('add_photos'); setCompactOpen(true); }}>Add photos</button></div>}
          {sourceRows}
          {owner && status !== 'cancelled' && <button className={button} disabled={busy || running || !sources.length || !selected || sources.some(source => !source.job_id)} onClick={() => void act(scan)}>Review files</button>}
        </section>
        <section className="space-y-4 rounded-xl bg-[#2e2e2e] p-4"><h2 className="font-semibold">Review and progress</h2>{counts}
          <div className="flex flex-wrap gap-2">
            {status === 'draft' && approveButton}
            {owner && !running && ['approved', 'running', 'interrupted'].includes(status) && <button className={primary} disabled={busy || !sealed || !selected || !reviewed} onClick={() => void start(false).catch(report)}>Resume</button>}
            {owner && !terminal && (running || status === 'running' || status === 'approved') && <button className={button} onClick={() => void act(() => stop(false))}>Pause</button>}
            {owner && view && !['completed', 'cancelled'].includes(status) && <button className={`${button} text-red-300`} onClick={() => void act(() => stop(true))}>Cancel batch</button>}
          </div>
          <p className="text-xs text-[#aaa]">Cancel stops pending work and keeps photos already committed. Skipped and completed files remain in the batch history.</p>
        </section>
      </div>
      <section className="space-y-3"><h2 className="font-semibold">Inventory <span className="text-sm font-normal text-[#aaa]">· up to 50 rows per page</span></h2>
        <div className="overflow-x-auto rounded-xl bg-[#2e2e2e]"><table data-testid="inventory-table" className="w-full text-left text-sm"><thead><tr className="border-b border-[#444]"><th className="p-3">File / source</th><th className="p-3">Size</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead>
          <tbody>{items.items.map(item => <tr key={item.id} data-testid="migration-item" className="border-b border-[#3d3d3d] align-top">
            <td className="max-w-xs break-all p-3">{item.relative_path}<div className="mt-1 text-xs text-[#aaa]">{sources.find(source => source.id === item.source_id)?.label}{item.revision > 1 ? ` · revision ${item.revision}` : ''}</div></td>
            <td className="whitespace-nowrap p-3">{bytes(item.original_bytes)}</td><td className="p-3"><span className={isPausedMigrationItem(item, status) ? 'text-[#bbb]' : item.status.includes('failed') || item.status.includes('conflict') ? 'text-red-300' : item.status === 'completed' ? 'text-green-400' : 'text-[#bbb]'}>{isPausedMigrationItem(item, status) ? 'Paused' : migrationItemStatusLabel(item.status)}</span>
              {progress[item.id] && <div className="mt-1 text-xs">{bytes(progress[item.id][0])} / {bytes(progress[item.id][1])}</div>}
              {(item.error?.message ?? item.error?.code ?? item.error_code) && <div className="mt-1 text-xs text-red-300">{item.error?.message ?? item.error?.code ?? item.error_code}</div>}
              {['job_conflict', 'restore_required'].includes(item.status) && <p className="mt-2 text-xs text-[#bbb]">Review the existing photo in a new tab, then Check again and Resume here. No second copy is uploaded.</p>}
              {!running && item.lease_expires_at && Date.parse(item.lease_expires_at) > Date.now() && <div className="mt-1 text-xs text-amber-300">Another page may be uploading. Pause the batch or retry after {new Date(item.lease_expires_at).toLocaleTimeString()}.</div>}
              {(item.warnings ?? (item.result?.warnings as string[] | undefined) ?? []).map((warning, index) => <div key={index} className="mt-1 text-xs text-amber-300">{warning}</div>)}
              {!retryDue(item) && <div className="text-xs text-amber-300">Retry after {new Date(item.retry_after ?? Number(item.result?.retryAt)).toLocaleString()}</div>}
            </td><td className="p-3">{owner && !running && !isPausedMigrationItem(item, status) && ['retryable_failed', 'waiting_claim', 'job_conflict', 'restore_required'].includes(item.status) && <div className="flex flex-wrap gap-2"><button className={button} disabled={!retryDue(item) || busy} onClick={() => void act(async () => { await request(`items/${item.id}`, { action: 'retry', ...(item.new_attempt_required ? { new_attempt_required: true } : {}) }); await refresh(); })}>{['job_conflict', 'restore_required'].includes(item.status) ? 'Check again' : 'Retry'}</button><button className={button} disabled={busy} onClick={() => void act(async () => { await request(`items/${item.id}`, { action: 'skip' }); await refresh(); })}>Skip</button></div>}
              {item.canonical_photo_id && ['job_conflict', 'restore_required'].includes(item.status) && <Link
                href={`/photo-actions?${new URLSearchParams({ action: item.status === 'job_conflict' ? 'move' : 'restore', photo: item.canonical_photo_id,
                  ...(sources.find(source => source.id === item.source_id)?.job_id ? { destination: sources.find(source => source.id === item.source_id)!.job_id } : {}) })}`}
                target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[#8bbaff] underline">
                {item.status === 'job_conflict' ? 'Review move' : 'Review restore'} (new tab)
              </Link>}
              {owner && !running && item.status === 'completed' && item.sidecar && item.warnings?.some(warning => /sidecar/i.test(warning)) && <button className={button} disabled={busy || !localSources.current.has(item.source_id)} onClick={() => void act(() => retryXmp(item))}>Retry XMP</button>}
            </td>
          </tr>)}</tbody></table></div>
        {!items.items.length && <p className="text-sm text-[#aaa]">Select a source and review its files to build the inventory.</p>}
        <div className="flex gap-2"><button className={button} disabled={!cursor || busy} onClick={() => void act(async () => { setCursor(null); await refresh(); })}>First page</button><button className={button} disabled={!items.next_cursor || busy} onClick={() => void act(async () => { const next = items.next_cursor; setCursor(next); await refresh(batchId.current, next); })}>Next page</button></div>
      </section>
      <section className="space-y-3 border-t border-[#444] pt-5"><h2 className="font-semibold">Recent batches</h2><div className="flex flex-wrap gap-3">{recent.map(batch => <Link className="rounded-lg bg-[#2e2e2e] p-3 text-sm text-[#73adff]" key={batch.id} href={`/migrate?batch=${batch.id}`} onClick={event => { event.preventDefault(); window.location.assign(`/migrate?batch=${batch.id}`); }}>{batch.script_name === 'add_photos' ? 'Add photos' : 'Folder migration'} · {batch.status} · {batch.id.slice(0, 8)}</Link>)}</div></section>
    </div>
    <SheetShell title="Add photos" size="compact" open={compactOpen} onOpenChange={setCompactOpen} footer={<div className="flex flex-wrap justify-end gap-2 text-white"><button className={button} disabled={busy || !sources.length} onClick={() => void act(scan)}>Review files</button>{status === 'draft' && approveButton}</div>}>
      <div className="space-y-4 text-white">{fileInput}{sourceRows}
        <label className="block text-sm">Sheet number<input aria-label="Sheet number" value={sheet} onChange={event => { setSheet(event.target.value); reviewedSources.current.clear(); }} className={`${field} mt-1`} disabled={!editable} /></label>
        <label className="block text-sm">Tags<input aria-label="Tags" value={tags} onChange={event => { setTags(event.target.value); reviewedSources.current.clear(); }} className={`${field} mt-1`} placeholder="Separate tags with commas" disabled={!editable} /></label>
        <div ref={compactReview} tabIndex={-1} className="outline-none" aria-label="Inventory review">{counts}</div>{error && <p className="text-sm text-red-300">{error}</p>}
      </div>
    </SheetShell>
  </main>;
}
