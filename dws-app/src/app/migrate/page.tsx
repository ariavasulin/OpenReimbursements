'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { fetchTags, invalidatePhotoCaches } from '@/lib/photos/api';
import SheetShell from '@/components/photos/sheet-shell';
import NewJobForm from '@/components/photos/new-job-form';
import FolderReview, { type FolderPatch } from '@/components/photos/migrate/folder-review';
import FolderTags from '@/components/photos/migrate/folder-tags';
import ProjectChoice, { projectLabel, type ProjectRef } from '@/components/photos/migrate/project-choice';
import AlbumChoice, { type AlbumValue } from '@/components/photos/migrate/album-choice';
import { button, card, dangerButton, field, hint, label as labelClass, primaryButton, quietButton } from '@/components/photos/migrate/styles';
import { supabase } from '@/lib/supabaseClient';
import { buildBrowserUploadDeps } from '@/lib/photos/upload-browser';
import { createUploadRequest } from '@/lib/photos/upload-http';
import type { UploadAttempt } from '@/lib/photos/upload-contract';
import { MigrationEngine } from '@/lib/photos/migration/engine';
import { directorySource, filesSource, type DirectoryHandle, type LocalSource } from '@/lib/photos/migration/inventory';
import { folderOf, isInsideFolder, type MigrationFolder } from '@/lib/photos/migration/folders';
import { scanMigrationSource } from '@/lib/photos/migration/scan';
import {
  createMigrationRequest, loadMigrationBatch, loadMigrationFolders, isPausedMigrationItem, migrationBatchName, migrationBatchStatusLabel,
  migrationExclusionLabel, migrationItemStatusLabel, retryDue,
  type BatchView, type ItemPage, type MigrationBatch, type MigrationItem, type MigrationSource, type MigrationSourceHint,
} from '@/lib/photos/migration/client';

// Import folders (plan Phase 6). Each folder becomes an album with the same name; a project
// and tags are optional, per folder. The words on this page are the app's three words --
// Album, Project, Tag -- and plain sentences; nothing internal reaches the screen.

const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3)).toLocaleString()} KB`;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const refreshAuth = async () => { const { data, error } = await supabase.auth.refreshSession(); return !error && !!data.session; };
type Mode = 'migrate_photos' | 'add_photos';
type SettledFolder = Partial<Pick<MigrationFolder, 'job_id' | 'jobs' | 'tags' | 'album_name' | 'album_id' | 'albums'>>;

export default function MigratePage() {
  const queryClient = useQueryClient();
  const [request] = useState(() => createMigrationRequest(refreshAuth));
  const [view, setView] = useState<BatchView | null>(null);
  const [sources, setSources] = useState<MigrationSource[]>([]);
  const [folders, setFolders] = useState<MigrationFolder[]>([]);
  const [recent, setRecent] = useState<MigrationBatch[]>([]);
  const [items, setItems] = useState<ItemPage>({ items: [], next_cursor: null });
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('migrate_photos');
  const [looseOpen, setLooseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [looseAlbumPending, setLooseAlbumPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [canPickFolders, setCanPickFolders] = useState(true);
  const [creatingFor, setCreatingFor] = useState<string | null>(null); // a picked folder's id, or 'loose'
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  // The loose-photos form. It exists before any file is chosen, so hints can pre-fill it.
  const [looseJob, setLooseJob] = useState<ProjectRef | null>(null);
  const [looseAlbum, setLooseAlbum] = useState<AlbumValue>({ kind: 'none' });
  const [looseTags, setLooseTags] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, [number, number]>>({});
  const [, setConnectedVersion] = useState(0);
  const localSources = useRef(new Map<string, LocalSource>());
  const readThisVisit = useRef(new Set<string>());
  const engine = useRef<MigrationEngine | null>(null);
  const batchId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const starting = useRef(false);
  const initStarted = useRef(false);
  const scanning = useRef<AbortController | null>(null);
  const edits = useRef<Promise<void>>(Promise.resolve());
  const failedEdits = useRef(new Set<string>());

  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (reason) { report(reason); } finally { setBusy(false); }
  };

  const refresh = useCallback(async (id = batchId.current, after: string | null = null, everything = true) => {
    if (!id) return;
    const [{ view: nextView, sources: nextSources, items: nextItems }, nextFolders] = await Promise.all([
      loadMigrationBatch(request, id, { after, includeSources: everything }),
      everything ? loadMigrationFolders(request, id) : undefined,
    ]);
    setView(nextView); setItems(nextItems); setMode(nextView.batch.script_name);
    if (nextSources) setSources(nextSources);
    if (nextFolders) setFolders(nextFolders);
    return { view: nextView, sources: nextSources, folders: nextFolders };
  }, [request]);

  const findProject = useCallback(async (jobNumber: string | undefined): Promise<ProjectRef | null> => {
    if (!jobNumber) return null;
    const { jobs } = await request<{ jobs: ProjectRef[] }>(`jobs?limit=100&q=${encodeURIComponent(jobNumber)}`);
    return jobs.find(job => job.job_number === jobNumber) ?? null;
  }, [request]);

  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    setCanPickFolders(typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function');
    void act(async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) { window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      setUserId(data.user.id);
      void fetchTags().then(setKnownTags).catch(() => undefined);
      const params = new URLSearchParams(window.location.search);
      const script = params.get('script_name') ?? params.get('script') ?? params.get('mode');
      const chosenMode: Mode = script === 'add_photos' ? 'add_photos' : 'migrate_photos';
      setMode(chosenMode); setLooseOpen(chosenMode === 'add_photos');
      let id = params.get('batch');
      const token = params.get('token');
      if (token) {
        if (!['migrate_photos', 'add_photos'].includes(params.get('script_name') ?? '')) {
          throw new Error('This link is missing its action. Reopen the original handoff link.');
        }
        const consumed = await request<{ migration_batch_id: string }>('handoffs/consume', { token, script_name: chosenMode });
        id = consumed.migration_batch_id;
        window.history.replaceState(null, '', `/migrate?batch=${encodeURIComponent(id)}`);
      }
      if (id) {
        batchId.current = id;
        const loaded = await refresh(id);
        const batch = loaded?.view.batch;
        if (batch?.script_name === 'add_photos') {
          const row = loaded?.folders?.find(folder => loaded.sources?.some(source => source.id === folder.source_id && source.kind === 'files'));
          if (row) {
            // A saved import: the form shows what was chosen.
            setLooseJob(row.jobs ?? null); setLooseTags(row.tags);
            setLooseAlbum(row.albums ? { kind: 'existing', ...row.albums } : row.album_name ? { kind: 'new', name: row.album_name } : { kind: 'none' });
          } else {
            // A fresh hand-off: the assistant's suggestions pre-fill the form. Nothing is created by this.
            const suggested = batch.requested_input ?? {};
            setLooseTags(suggested.tags ?? []);
            if (suggested.album_name) setLooseAlbum({ kind: 'new', name: suggested.album_name });
            setLooseJob(await findProject(suggested.job_number));
          }
          if (batch.status === 'draft') setLooseOpen(true);
        }
        if (loaded?.sources?.length) setMessage('Choose each folder again to carry on. Photos already imported are kept, and nothing is imported twice.');
      }
      const batches = await request<{ batches: MigrationBatch[] }>('batches'); setRecent(batches.batches);
    });
  }, [refresh, request, findProject]);

  useEffect(() => () => { engine.current?.stop(); scanning.current?.abort(); }, []);
  useEffect(() => {
    if (!view || view.batch.status === 'draft') return;
    const timer = setInterval(() => { if (!busy && !running) void refresh(batchId.current, cursor, false).catch(report); }, 5000);
    return () => clearInterval(timer);
  }, [view?.batch.status, refresh, busy, running, cursor]);

  const ensureBatch = async (script: Mode) => {
    if (batchId.current) return batchId.current;
    const { batch } = await request<{ batch: MigrationBatch }>('batches', { script_name: script });
    batchId.current = batch.id;
    window.history.replaceState(null, '', `/migrate?batch=${batch.id}`);
    setView({ batch, can_mutate: true, counts: {} });
    return batch.id;
  };

  /** What the assistant suggested for a picked folder (or for loose photos). Suggestions only. */
  const suggestionFor = (label: string): MigrationSourceHint | undefined => {
    const suggested = view?.batch.requested_input;
    return mode === 'add_photos' ? (suggested ? { label, ...suggested } : undefined) : suggested?.sources?.find(source => source.label === label);
  };

  /** Read one picked folder (or selection of photos) and save what is in it. */
  const read = async (source: MigrationSource, local: LocalSource, script: Mode) => {
    const id = await ensureBatch(script);
    const controller = new AbortController(); scanning.current = controller;
    try {
      setMessage(`Reading ${source.label}…`);
      await scanMigrationSource(request, { batchId: id, source, local, register: !view || view.batch.status === 'draft',
        selectionRules: { tags: Array.isArray(source.selection_rules?.tags) ? source.selection_rules.tags as string[] : [] },
        signal: controller.signal,
        onChunk: count => setMessage(`Reading ${source.label}: about ${(count * 500).toLocaleString()} files so far…`),
      });
      readThisVisit.current.add(source.id);
      return await refresh(id);
    } finally { scanning.current = null; }
  };

  const connect = async (local: LocalSource, existing?: MigrationSource) => {
    const script: Mode = existing || sources.length ? mode : local.kind === 'files' ? 'add_photos' : 'migrate_photos';
    if (!existing) setMode(script);
    let source = existing;
    if (!source) {
      const suggested = suggestionFor(local.label);
      const loose = local.kind === 'files';
      const project = loose ? looseJob : await findProject(suggested?.job_number);
      source = { id: crypto.randomUUID(), label: local.label, kind: local.kind, batch_id: batchId.current ?? '', job_id: project?.id ?? null,
        selection_rules: { tags: loose ? looseTags : suggested?.tags ?? [] } };
      setSources(current => [...current, source!]);
    }
    localSources.current.set(source.id, local); readThisVisit.current.delete(source.id); setConnectedVersion(version => version + 1);
    const loaded = await read(source, local, script);
    if (local.kind === 'files' && !existing && looseAlbum.kind !== 'none' && loaded?.folders?.some(row => row.source_id === source!.id)) {
      await saveFolders(source, '', false, looseAlbum.kind === 'existing' ? { album_id: looseAlbum.id } : { album_name: looseAlbum.name });
    }
    setCursor(null);
    const found = loaded?.folders?.filter(row => row.source_id === source!.id) ?? [];
    setMessage(local.kind === 'files' ? 'Your photos are ready. Pick a project, an album, or both, then start.'
      : found.length ? `Found ${plural(found.length, 'folder')} with photos in ${source.label}. Check them below, then start.` : `No photos were found in ${source.label}.`);
    heading.current?.focus();
  };

  const chooseFolder = async (existing?: MigrationSource) => {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!picker) { setCanPickFolders(false); return; }
    let handle: DirectoryHandle;
    try { handle = await picker({ mode: 'read' }); }
    catch (reason) { if (reason instanceof DOMException && reason.name === 'AbortError') return; throw reason; } // closed the picker: not an error
    await connect(directorySource(handle), existing);
  };

  /** One review edit, sent in order. It never locks the page, so typing is not interrupted. */
  const saveFolders = (source: MigrationSource, folder: string, includeSubfolders: boolean, body: Record<string, unknown>, optimistic: SettledFolder = {}) => {
    const reaches = (row: MigrationFolder) => row.source_id === source.id && (includeSubfolders ? isInsideFolder(row.folder, folder) : row.folder === folder);
    setFolders(rows => rows.map(row => reaches(row) ? { ...row, ...optimistic } : row));
    setSaving(count => count + 1);
    // Track failed choices per row/field: correcting an album via its ID must also clear
    // a failed name edit, and a successful whole-folder choice supersedes its row edits.
    const fields = [...new Set(Object.keys(body).map(key => key === 'album_id' || key === 'album_name' ? 'album' : key))];
    const editKeys = folders.filter(reaches).flatMap(row => fields.map(field => JSON.stringify([row.source_id, row.folder, field])));
    const sent = edits.current.then(async () => {
      const result = await request<{ settled?: SettledFolder }>(`sources/${source.id}/folders`, { folder, include_subfolders: includeSubfolders, ...body }, { method: 'PATCH' });
      for (const key of editKeys) failedEdits.current.delete(key);
      if (result.settled) setFolders(rows => rows.map(row => reaches(row) ? { ...row, ...result.settled } : row));
    });
    edits.current = sent.catch(async reason => {
      for (const key of editKeys) failedEdits.current.add(key);
      report(reason);
      if (batchId.current) setFolders(await loadMigrationFolders(request, batchId.current).catch(() => [] as MigrationFolder[]));
    }).finally(() => setSaving(count => count - 1));
    return edits.current;
  };
  const patchFolders = (source: MigrationSource, folder: string, includeSubfolders: boolean, patch: FolderPatch) => {
    setError('');
    void saveFolders(source, folder, includeSubfolders, {
      ...('job' in patch ? { job_id: patch.job?.id ?? null } : {}), ...('tags' in patch ? { tags: patch.tags } : {}),
      ...('album_name' in patch ? { album_name: patch.album_name } : {}),
    }, { ...('job' in patch ? { job_id: patch.job?.id ?? null, jobs: patch.job ?? null } : {}), ...('tags' in patch ? { tags: patch.tags } : {}) });
  };

  const looseSource = sources.find(source => source.kind === 'files');
  const looseRow = looseSource ? folders.find(row => row.source_id === looseSource.id && row.folder === '') : undefined;
  /** The loose-photos form edits its row once there is one; before that it only holds the choice. */
  const editLoose = (change: { job?: ProjectRef | null; album?: AlbumValue; tags?: string[] }) => {
    if ('job' in change) setLooseJob(change.job ?? null);
    if (change.album) setLooseAlbum(change.album);
    if (change.tags) setLooseTags(change.tags);
    if (!looseSource || !looseRow) return;
    setError('');
    if ('job' in change) void saveFolders(looseSource, '', false, { job_id: change.job?.id ?? null }, { job_id: change.job?.id ?? null, jobs: change.job ?? null });
    if (change.tags) void saveFolders(looseSource, '', false, { tags: change.tags }, { tags: change.tags });
    if (change.album) void saveFolders(looseSource, '', false, change.album.kind === 'existing' ? { album_id: change.album.id } : { album_name: change.album.kind === 'new' ? change.album.name : null });
  };

  const openNewProject = async (target: string) => {
    setCreatingFor(target);
    const { jobs } = await request<{ jobs: ProjectRef[] }>('jobs?limit=100'); setProjects(jobs);
  };

  const makeEngine = (id: string, savedFolders = folders) => {
    const uploadRequest = createUploadRequest({ refreshAuth });
    return new MigrationEngine({ batchId: id, uploaderId: userId, sources, folders: savedFolders,
      localSources: localSources.current, request, deps: buildBrowserUploadDeps(),
      prepare: (input, options) => uploadRequest<UploadAttempt>('prepare', input, options),
      onChange: async completedItemId => {
        invalidatePhotoCaches(queryClient);
        setProgress(current => {
          if (!completedItemId) return {};
          const next = { ...current }; delete next[completedItemId]; return next;
        });
        await refresh(id, null, !completedItemId);
      },
      onProgress: (itemId, sent, total) => setProgress(current => ({ ...current, [itemId]: [sent, total] })),
    });
  };

  const retryXmp = async (item: MigrationItem) => {
    const worker = makeEngine(batchId.current!); engine.current = worker;
    setRunning(true);
    try {
      const result = await worker.upload(item);
      if (!['done', 'duplicate'].includes(result.status)) throw new Error(result.error ?? 'This photo can no longer have an XMP file attached.');
      setMessage(result.sidecarRetry ? 'The XMP file still needs attention. Choose the folder again and retry.' : 'The XMP file was checked. The photo itself was left as it is.');
    } finally { engine.current = null; setRunning(false); await refresh(); }
  };

  const start = async (approve: boolean) => {
    if (starting.current || engine.current) return;
    starting.current = true; setPreparing(true);
    let savedFolders: MigrationFolder[];
    const id = batchId.current!;
    try {
      if (sources.some(source => !readThisVisit.current.has(source.id))) throw new Error('Choose every folder again before starting.');
      await edits.current; // blur queues its edit before the Start click
      if (failedEdits.current.size) throw new Error('An edit could not be saved. Make that choice again before starting.');
      savedFolders = await loadMigrationFolders(request, id);
      if (approve) await request(`batches/${id}`, { action: 'approve' }, { method: 'PATCH' });
      await request(`batches/${id}`, { action: 'resume' }, { method: 'PATCH' });
    } catch (reason) { starting.current = false; setPreparing(false); throw reason; }
    setLooseOpen(false); setRunning(true); setProgress({}); setError(''); setMessage('Importing. Keep this page open until it finishes.');
    const worker = makeEngine(id, savedFolders);
    setPreparing(false);
    engine.current = worker;
    try { await worker.run(); }
    catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) report(reason);
    } finally {
      setRunning(false); starting.current = false; engine.current = null;
      const after = await refresh(id);
      // Never leave "Importing…" on a page that has stopped. Pause and Cancel set their own message, so only replace ours.
      const finished = after?.view.batch.status === 'completed';
      const done = after?.view.batch.script_name === 'add_photos' ? 'Finished. Your photos are in DWS Photos.' : 'Finished. Every folder is now an album: find them under Albums.';
      setMessage(current => finished ? done : current.startsWith('Importing.') ? '' : current);
    }
  };

  const stop = async (cancel: boolean) => {
    engine.current?.stop(); scanning.current?.abort();
    await request(`batches/${batchId.current}`, { action: cancel ? 'cancel' : 'pause' }, { method: 'PATCH' });
    await refresh();
    setMessage(cancel ? 'Import cancelled. Photos already imported stay in DWS Photos.' : 'Paused. Keep this page open, or choose your folders again when you come back.');
  };

  const status = view?.batch.status ?? 'draft';
  const owner = view?.can_mutate ?? true;
  const editable = owner && status === 'draft' && !preparing;
  const terminal = status === 'completed' || status === 'cancelled';
  const totals = view?.counts ?? {};
  const byStatus = (totals.by_status ?? {}) as Record<string, number>;
  const count = (key: string) => Number(byStatus[key] ?? 0);
  const allRead = sources.length > 0 && sources.every(source => localSources.current.has(source.id) && readThisVisit.current.has(source.id)
    && source.sealed_scan_id && source.sealed_scan_id === source.scan_id);
  const needsAttention = !running && ['running', 'approved'].includes(status) && (Boolean(error) || ['retryable_failed', 'job_conflict', 'restore_required'].some(state => count(state) > 0));
  const photos = folders.reduce((total, row) => total + row.photo_count, 0);
  // AC-18: loose photos need a project or an album. A folder always has its album, so this only ever stops loose photos.
  const looseNeedsChoice = Boolean(looseRow && looseRow.photo_count > 0 && !looseRow.job_id && !looseRow.album_id && !looseRow.album_name);
  const canStart = owner && allRead && photos > 0 && !looseNeedsChoice && !looseAlbumPending && !busy && !running && !preparing;
  const imported = count('completed'), already = count('skipped_duplicate'), leftOut = count('skipped_unsupported');
  const waiting = ['pending', 'hashing', 'waiting_claim', 'uploading', 'finalizing'].reduce((total, key) => total + count(key), 0);
  const trouble = count('retryable_failed') + count('job_conflict') + count('restore_required');
  const exclusions = Object.entries((totals.exclusions_by_reason ?? {}) as Record<string, number>);
  const folderFor = (item: MigrationItem) => folders.find(row => row.source_id === item.source_id && row.folder === folderOf(item.relative_path));

  const startButton = <button className={primaryButton} disabled={!canStart} onClick={() => void start(true).catch(report)}>Start import</button>;
  const summary = (
    <div data-testid="batch-counts" className="space-y-1 text-base">
      <p><strong>{plural(photos, 'photo')}</strong>{mode === 'migrate_photos' && <> in <strong>{plural(folders.filter(row => row.photo_count > 0).length, 'folder')}</strong></>} · {size(Number(totals.upload_bytes ?? totals.total_bytes ?? 0))}</p>
      {status !== 'draft' && <p>{plural(imported, 'photo')} imported{already > 0 && <> · {already.toLocaleString()} already in DWS Photos</>}{waiting > 0 && <> · {waiting.toLocaleString()} still to go</>}{trouble > 0 && <> · <span className="text-amber-300">{plural(trouble, 'needs', 'need')} attention</span></>}</p>}
    </div>
  );

  const newProject = (target: string, suggestedName: string, onDone: (project: ProjectRef) => void) => creatingFor === target
    ? <div className="mt-3"><NewJobForm jobs={projects} initialName={suggestedName} onCancel={() => setCreatingFor(null)} onDone={project => { onDone(project); setCreatingFor(null); }} /></div>
    : <button type="button" className={`${quietButton} mt-2`} onClick={() => void openNewProject(target).catch(report)}>
        {suggestedName ? `Make a new project “${suggestedName}”` : 'Make a new project'}</button>;

  const looseForm = (
    <div className="space-y-5 text-white">
      <label className={labelClass}>Photos
        <input aria-label="Select photos" type="file" multiple className={`${field} mt-1`} disabled={busy || !owner || !editable}
          onChange={event => {
            const files = event.target.files; if (!files?.length) return;
            void act(async () => { try { await connect(filesSource(files), looseSource); } finally { event.target.value = ''; } });
          }} />
        <span className={`${hint} mt-1 block font-normal`}>Up to 500 at a time. For more, import the whole folder from a computer.</span>
      </label>
      <p className={hint} data-testid="loose-rule">Pick a project, an album, or both.</p>
      <div><span className={labelClass}>Project <span className="font-normal text-[#c4c4c4]">(optional)</span></span>
        <div className="mt-1"><ProjectChoice request={request} value={looseJob} disabled={!editable} ariaLabel="Project for these photos" onChange={job => editLoose({ job })} /></div>
        {editable && newProject('loose', looseJob ? '' : suggestionFor('')?.new_project_name ?? '', project => editLoose({ job: project }))}
      </div>
      <div><label className={labelClass} htmlFor="loose-album">Album <span className="font-normal text-[#c4c4c4]">(optional)</span></label>
        <div className="mt-1"><AlbumChoice inputId="loose-album" value={looseAlbum} onPendingChange={setLooseAlbumPending} disabled={!editable} onChange={album => editLoose({ album })} /></div>
      </div>
      <div><span className={labelClass}>Tags <span className="font-normal text-[#c4c4c4]">(optional)</span></span>
        <div className="mt-1"><FolderTags tags={looseTags} known={knownTags} disabled={!editable} ariaLabel="Tags for these photos" onChange={tags => editLoose({ tags })} /></div>
      </div>
      {looseRow && <div aria-label="What will be imported">{summary}</div>}
      {looseNeedsChoice && <p className="text-base text-amber-300" role="status">Choose a project or an album to start. That is how you will find these photos again.</p>}
      {error && <p className="text-base text-red-300" role="alert">{error}</p>}
    </div>
  );

  return <main className="h-dvh overflow-y-auto bg-[#222222] text-white">
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8">
      <header><Link className={quietButton} href="/photos">← DWS Photos</Link></header>
      <section className="space-y-3">
        <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold outline-none">{mode === 'add_photos' ? 'Add photos' : 'Import folders'}</h1>
        {mode === 'migrate_photos'
          ? <p className="max-w-3xl text-lg leading-7">Each folder becomes an album with the same name.</p>
          : <p className="max-w-3xl text-lg leading-7">Add up to 500 photos to a project, an album, or both.</p>}
        <p className={`${hint} max-w-3xl`}>Your files stay where they are: this copies them into DWS Photos. Keep this page open while it runs. If you close it, come back to this page and choose the same {mode === 'add_photos' ? 'photos' : 'folders'} again; nothing is imported twice.</p>
        {view && !owner && <p className={`${card} text-base`}>You can look at this import. Only the person who started it can change, start, or cancel it.</p>}
      </section>

      {owner && !terminal && !running && (
        <section className="space-y-3" aria-label="Choose what to import">
          {canPickFolders
            ? mode === 'migrate_photos' && editable && <button className={primaryButton} disabled={busy} onClick={() => void act(() => chooseFolder())}>{sources.length ? 'Choose another folder' : 'Choose folder'}</button>
            : <div className={card} data-testid="folders-unavailable">
                <h2 className="text-xl font-semibold">Importing folders needs a computer</h2>
                <p className={`${hint} mt-1`}>This browser cannot open folders. Whole folders can be imported with Chrome or Edge on a computer: open DWS Photos there and choose Import folders. {editable && !sources.some(source => source.kind === 'directory') && 'Here, you can add up to 500 photos at a time instead.'}</p>
              </div>}
          {editable && (mode === 'add_photos' || !looseSource) && (
            <div><button className={canPickFolders && mode === 'migrate_photos' ? quietButton : primaryButton} disabled={busy}
              onClick={() => setLooseOpen(true)}>{canPickFolders && mode === 'migrate_photos' ? 'Add individual photos instead' : looseSource ? 'Choose photos and where they go' : 'Add photos'}</button></div>
          )}
        </section>
      )}

      {error && !looseOpen && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-base text-red-200">{error}</p>}
      <p role="status" aria-live="polite" className={hint}>{busy ? message || 'Working…' : message}{saving > 0 && ' Saving…'}</p>

      <FolderReview request={request} sources={sources} folders={folders} editable={editable} knownTags={knownTags} busy={busy || running}
        isConnected={id => localSources.current.has(id) && readThisVisit.current.has(id)}
        onReconnect={owner && !running && status !== 'cancelled' && canPickFolders ? source => void act(() => chooseFolder(source)) : undefined}
        onPatch={patchFolders}
        sourceActions={source => newProject(source.id, suggestionFor(source.label)?.new_project_name ?? '',
          project => patchFolders(source, '', true, { job: project }))} />

      {looseSource && (
        <section className={card} data-testid="migration-source" aria-label="Individual photos">
          <h2 className="text-xl font-semibold">Individual photos</h2>
          <p className={hint}>{looseRow ? plural(looseRow.photo_count, 'photo') : 'Not read yet.'} · Project: {looseRow?.jobs ? projectLabel(looseRow.jobs) : 'No project'} · Album: {looseRow?.albums?.name ?? looseRow?.album_name ?? 'No album'}{looseRow?.tags.length ? ` · Tags: ${looseRow.tags.join(', ')}` : ''}</p>
          {owner && !running && status !== 'cancelled' && <button className={`${button} mt-3`} onClick={() => setLooseOpen(true)}>
            {localSources.current.has(looseSource.id) && readThisVisit.current.has(looseSource.id) ? 'Change' : 'Choose these photos again'}</button>}
        </section>
      )}

      {sources.length > 0 && (
        <section className={`${card} space-y-4`} aria-labelledby="import-progress">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="import-progress" className="text-xl font-semibold">{status === 'draft' ? 'Ready to import' : 'Progress'}</h2>
            <p data-testid="batch-status" data-status={status} className="text-base">
              <strong className={status === 'completed' ? 'text-green-400' : status === 'cancelled' || needsAttention ? 'text-amber-300' : 'text-[#8bbaff]'}>{migrationBatchStatusLabel(status, needsAttention)}</strong></p>
          </div>
          {summary}
          <div className="flex flex-wrap gap-3">
            {status === 'draft' && startButton}
            {owner && !running && ['approved', 'running', 'interrupted'].includes(status) && <button className={primaryButton} disabled={busy || !allRead} onClick={() => void start(false).catch(report)}>Resume</button>}
            {owner && !terminal && (running || status === 'running' || status === 'approved') && <button className={button} onClick={() => void act(() => stop(false))}>Pause</button>}
            {owner && view && !terminal && <button className={dangerButton} onClick={() => void act(() => stop(true))}>Cancel import</button>}
          </div>
          {status === 'draft' && photos > 0 && !allRead && <p className={hint}>Choose every folder again to start.</p>}
          {!terminal && <p className={hint}>Cancel stops the import and keeps every photo already imported.</p>}
          {status === 'completed' && <p className="text-base"><Link className="text-[#8bbaff] underline underline-offset-2" href="/photos/albums">Find your folders under Albums</Link></p>}
          <details className="rounded-lg border border-[#484848] p-3">
            <summary className="min-h-11 cursor-pointer py-2 text-base font-medium">More detail</summary>
            <div className="mt-2 space-y-2 text-base text-[#d6d6d6]">
              <p>{plural(Number(totals.total ?? 0), 'file')} found · {plural(Number(totals.xmp ?? 0), 'photo')} with an XMP file beside {Number(totals.xmp ?? 0) === 1 ? 'it' : 'them'} · {plural(leftOut, 'file')} left out</p>
              <p>An XMP file is imported together with the photo it belongs to. Left out on purpose: Picasa’s own files, hidden and system files, files that are not photos or videos, and XMP files that match no photo or more than one.</p>
              {exclusions.length > 0 && <ul className="list-disc pl-6">{exclusions.map(([reason, total]) => <li key={reason}>{migrationExclusionLabel(reason)}: {total.toLocaleString()}</li>)}</ul>}
              {Number(totals.warnings ?? 0) > 0 && <p>{plural(Number(totals.warnings), 'note')} on individual files, shown in the list below.</p>}
            </div>
          </details>
        </section>
      )}

      {(items.items.length > 0 || cursor) && (
        <section className="space-y-3" aria-labelledby="import-files"><h2 id="import-files" className="text-xl font-semibold">Files <span className="text-base font-normal text-[#c4c4c4]">· 50 at a time</span></h2>
          <div className="overflow-x-auto rounded-xl bg-[#2e2e2e]"><table data-testid="inventory-table" className="w-full text-left text-base"><thead><tr className="border-b border-[#444]"><th className="p-3 font-medium">File</th><th className="p-3 font-medium">Size</th><th className="p-3 font-medium">What happened</th><th className="p-3 font-medium"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{items.items.map(item => {
              const paused = isPausedMigrationItem(item, status); const row = folderFor(item);
              const bad = item.status.includes('failed') || item.status === 'job_conflict' || item.status === 'restore_required';
              return <tr key={item.id} data-testid="migration-item" data-status={item.status} className="border-b border-[#3d3d3d] align-top">
                <td className="max-w-xs break-all p-3">{item.relative_path}<div className="mt-1 text-[#c4c4c4]">{sources.find(source => source.id === item.source_id)?.label}{item.revision > 1 ? ' · changed since it was first read' : ''}</div></td>
                <td className="whitespace-nowrap p-3">{size(item.original_bytes)}</td>
                <td className="p-3"><span className={paused ? 'text-[#c4c4c4]' : bad ? 'text-red-300' : item.status === 'completed' ? 'text-green-400' : 'text-[#c4c4c4]'}>{paused ? 'Paused' : migrationItemStatusLabel(item.status)}</span>
                  {item.status === 'skipped_duplicate' && row && (row.album_name || row.albums) && <div className="mt-1 text-[#c4c4c4]">The photo you already have was added to the album.</div>}
                  {progress[item.id] && <div className="mt-1">{size(progress[item.id][0])} of {size(progress[item.id][1])}</div>}
                  {(item.error?.message ?? item.error?.code ?? item.error_code) && <div className="mt-1 text-red-300">{item.error?.message ?? item.error?.code ?? item.error_code}</div>}
                  {item.status === 'job_conflict' && <p className="mt-2 text-[#c4c4c4]">You already have this photo, in a different project. It was added to the album and kept its project. To move it, review the move in a new tab, then press Check again here.</p>}
                  {item.status === 'restore_required' && <p className="mt-2 text-[#c4c4c4]">You already have this photo, in the trash. Restore it in a new tab, then press Check again here. No second copy is made.</p>}
                  {!running && item.lease_expires_at && Date.parse(item.lease_expires_at) > Date.now() && <div className="mt-1 text-amber-300">Another page may be importing this. Pause, or try again after {new Date(item.lease_expires_at).toLocaleTimeString()}.</div>}
                  {(item.warnings ?? (item.result?.warnings as string[] | undefined) ?? []).map((warning, index) => <div key={index} className="mt-1 text-amber-300">{migrationExclusionLabel(warning) === 'Other files' ? warning : migrationExclusionLabel(warning)}</div>)}
                  {!retryDue(item) && <div className="text-amber-300">Try again after {new Date(item.retry_after ?? Number(item.result?.retryAt)).toLocaleString()}</div>}
                </td>
                <td className="p-3">{owner && !running && !paused && ['retryable_failed', 'waiting_claim', 'job_conflict', 'restore_required'].includes(item.status) && <div className="flex flex-wrap gap-2">
                    <button className={button} disabled={!retryDue(item) || busy} onClick={() => void act(async () => { await request(`items/${item.id}`, { action: 'retry', ...(item.new_attempt_required ? { new_attempt_required: true } : {}) }); await refresh(); })}>{['job_conflict', 'restore_required'].includes(item.status) ? 'Check again' : 'Retry'}</button>
                    <button className={button} disabled={busy} onClick={() => void act(async () => { await request(`items/${item.id}`, { action: 'skip' }); await refresh(); })}>Skip</button></div>}
                  {item.canonical_photo_id && ['job_conflict', 'restore_required'].includes(item.status) && <Link target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center text-[#8bbaff] underline underline-offset-2"
                    href={`/photo-actions?${new URLSearchParams({ action: item.status === 'job_conflict' ? 'move' : 'restore', photo: item.canonical_photo_id, ...(row?.job_id ? { destination: row.job_id } : {}) })}`}>
                    {item.status === 'job_conflict' ? 'Review move' : 'Review restore'} (new tab)</Link>}
                  {owner && !running && item.status === 'completed' && item.sidecar && item.warnings?.some(warning => /sidecar/i.test(warning)) && <button className={button} disabled={busy || !localSources.current.has(item.source_id)} onClick={() => void act(() => retryXmp(item))}>Retry XMP</button>}
                </td>
              </tr>;
            })}</tbody></table></div>
          {/* Only when there is more than one page: controls that cannot help are hidden. */}
          {(cursor || items.next_cursor) && <div className="flex flex-wrap gap-3"><button className={button} disabled={!cursor || busy} onClick={() => void act(async () => { setCursor(null); await refresh(batchId.current, null, false); })}>First page</button><button className={button} disabled={!items.next_cursor || busy} onClick={() => void act(async () => { const next = items.next_cursor; setCursor(next); await refresh(batchId.current, next, false); })}>Next page</button></div>}
        </section>
      )}

      {recent.length > 0 && (
        <section className="space-y-3 border-t border-[#444] pt-5" aria-labelledby="earlier-imports"><h2 id="earlier-imports" className="text-xl font-semibold">Earlier imports</h2>
          <ul className="grid gap-3 sm:grid-cols-2">{recent.map(batch => <li key={batch.id}>
            <Link className={`${card} flex min-h-11 flex-col gap-1 text-base hover:bg-[#383838]`} href={`/migrate?batch=${batch.id}`} onClick={event => { event.preventDefault(); window.location.assign(`/migrate?batch=${batch.id}`); }}>
              <span className="break-words font-medium text-[#8bbaff]">{migrationBatchName(batch)}</span><span className="text-[#c4c4c4]">{migrationBatchStatusLabel(batch.status)}</span></Link></li>)}</ul>
        </section>
      )}
    </div>
    <SheetShell title="Add photos" size="full" open={looseOpen} onOpenChange={setLooseOpen}
      footer={<div className="flex flex-wrap justify-end gap-3 text-white"><button className={button} onClick={() => setLooseOpen(false)}>{status === 'draft' ? 'Not now' : 'Close'}</button>{status === 'draft' && startButton}</div>}>
      {looseForm}
    </SheetShell>
  </main>;
}
