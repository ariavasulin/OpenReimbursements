'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Briefcase } from 'lucide-react';
import { toast } from 'sonner';
import { fetchDeletedAlbums, fetchDeletedJobs, fetchJson, invalidatePhotoCaches, purgeTrash, restoreAlbum, restoreJob,
  type DeletedAlbum, type DeletedJob, type PurgeRequest } from '@/lib/photos/api';
import { actionAlert as alert, actionButton as button, trashDisclosure } from '@/lib/photos/action-client';
import type { PurgeMarked, TrashPhoto, TrashResponse } from '@/lib/photos/action-types';
import ActionThumbnail from '@/components/photos/action-thumbnail';
import ConfirmDialog from '@/components/photos/confirm-dialog';
import { jobLabel, photoName, plural, projectName } from '@/lib/photos/format';
import { photoPath } from '@/lib/photos/photo-link';
import { toggleSelection } from '@/lib/photos/selection';

const tall = 'min-h-11 text-base';
const forever = `${button} ${tall} border-red-900 text-red-200 hover:border-red-400`;
const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the 30-day limit';
const expired = (iso: string) => Date.parse(iso) <= Date.now();

/** One "Delete forever" awaiting its confirmation. `done` words the result from what the server marked. */
type PendingPurge = { request: PurgeRequest; title: string; body: ReactNode; done(marked: PurgeMarked): string };

/** A trashed photo's project, in words; says so when the project itself was deleted. */
function projectOf(photo: Pick<TrashPhoto, 'job' | 'job_id'>): string {
  return photo.job?.deleted_at ? `${jobLabel(photo.job)} (project deleted)` : projectName(photo.job, photo.job_id);
}

/**
 * Trash: deleted projects, deleted albums, and trashed photos. Each can be
 * restored for 30 days, or deleted forever at once (anyone signed in).
 */
export default function TrashPage() {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingPurge | null>(null);
  const [purging, setPurging] = useState(false);
  const { data, error, isFetching } = useQuery({
    queryKey: ['photo-trash', cursor],
    queryFn: () => fetchJson<TrashResponse>(`/api/photos/trash?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, 'Could not load the trash', { cache: 'no-store' }),
    staleTime: 0,
  });
  const albums = useQuery({ queryKey: ['photo-albums-deleted'], queryFn: fetchDeletedAlbums, staleTime: 0 });
  const projects = useQuery({ queryKey: ['photo-jobs-deleted'], queryFn: fetchDeletedJobs, staleTime: 0 });

  const refresh = () => invalidatePhotoCaches(queryClient);

  const restore = async (kind: 'album' | 'project', item: DeletedAlbum | DeletedJob) => {
    setRestoring(item.id);
    try {
      if (kind === 'album') {
        await restoreAlbum(item.id);
        toast.success(`Album “${item.name}” restored`, { description: 'It is back under Albums with its photos.' });
      } else {
        const { restored } = await restoreJob(item.id);
        toast.success(`Project “${item.name}” restored`, { description: restored > 0 ? `${plural(restored, 'photo')} came back with it.` : 'It is back under Projects.' });
      }
      refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : `Failed to restore the ${kind}`);
    } finally {
      setRestoring(null);
    }
  };

  const purge = async ({ request, done }: Pick<PendingPurge, 'request' | 'done'>) => {
    setPurging(true);
    const id = toast.loading('Deleting forever...');
    try {
      const { marked, stuck } = await purgeTrash(request, (removed, remaining) => {
        if (remaining > 0) toast.loading(`Deleting forever... ${removed} removed, ${remaining} to go`, { id });
      });
      if (stuck > 0) {
        toast.warning(`${plural(stuck, 'photo')} could not be removed yet`, { id,
          description: 'They are out of Trash and cannot be restored. Press “Finish deleting” at the top of Trash to try again.' });
      } else {
        toast.success(done(marked), { id });
      }
      setSelected(new Set());
      setCursor(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Failed to delete forever', { id,
        description: 'It may have stopped part-way. Anything already gone from Trash cannot be restored; “Finish deleting” at the top of Trash completes it.' });
    } finally {
      refresh();
      setPurging(false);
      setPending(null);
    }
  };

  const photos = data?.photos ?? [];
  const deletedAlbums = albums.data ?? [];
  const deletedProjects = projects.data?.jobs ?? [];
  const waiting = data?.pending_purge ?? 0;
  const loading = isFetching || albums.isFetching || projects.isFetching;
  const failed = Boolean(error || albums.error || projects.error);
  const nothing = !loading && !failed && photos.length === 0 && deletedAlbums.length === 0 && deletedProjects.length === 0 && !cursor;
  const busy = purging || restoring !== null;
  // Only photos still listed count as selected, so a restore or refresh elsewhere never leaves a stale pick.
  const chosen = photos.filter(photo => selected.has(photo.id)).map(photo => photo.id);
  const toggle = (photoId: string) => setSelected(current => toggleSelection(current, photoId).selected);
  const photosDeleted = (marked: PurgeMarked) => `${plural(marked.photos, 'photo')} deleted forever`;
  const photoTotal = data?.next_cursor || cursor ? `more than ${plural(photos.length, 'photo')}` : plural(photos.length, 'photo');

  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-5 pb-40 sm:px-8">
    <Link href="/photos" className="desktop:hidden -ml-2 flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-base font-medium text-[#8bbaff]"><span aria-hidden="true">&lsaquo;</span>DWS Photos</Link>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl space-y-2">
        <h1 className="text-2xl font-semibold">Trash</h1>
        <p className="text-base leading-relaxed text-[#bbb]">{trashDisclosure} Anyone signed in can restore, or delete forever. After 30 days a photo is gone for good.</p>
      </div>
      <button className={forever} disabled={busy} onClick={() => setPending({
        request: { everything: true },
        title: 'Empty the trash?',
        body: <>
          <p>Deleted forever, with the photo files: {plural(deletedProjects.length, 'project')}, {plural(deletedAlbums.length, 'album')}, and {photoTotal}, plus anything moved to Trash before you confirm.</p>
          <p>This cannot be undone.</p>
        </>,
        done: () => 'Trash emptied',
      })}>Empty trash</button>
    </header>
    {error && <p role="alert" className={alert}>{error.message}</p>}
    {albums.error && <p role="alert" className={alert}>{albums.error.message}</p>}
    {projects.error && <p role="alert" className={alert}>{projects.error.message}</p>}

    {waiting > 0 && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-700 bg-amber-950/30 p-4">
      <p className="min-w-0 flex-1 basis-60 text-base text-amber-100">{plural(waiting, 'photo')} {waiting === 1 ? 'is' : 'are'} still being deleted forever. {waiting === 1 ? 'It is' : 'They are'} out of Trash and cannot be restored.</p>
      <button className={forever} disabled={busy} onClick={() => void purge({ request: {}, done: () => 'Finished deleting' })}>Finish deleting</button>
    </div>}

    {nothing && waiting === 0 && <p className="rounded-xl bg-[#2e2e2e] p-5 text-base text-[#bbb]">The trash is empty.</p>}

    {deletedProjects.length > 0 && <section aria-label="Deleted projects" className="space-y-3">
      <h2 className="text-lg font-semibold">Projects · {deletedProjects.length}</h2>
      <p className="text-base text-[#bbb]">A deleted project took its photos to Trash with it. Restoring brings them back together.</p>
      {projects.data?.truncated && <p className="text-sm text-[#bbb]">Showing the {deletedProjects.length} most recently deleted. Empty trash also removes the rest.</p>}
      <div className="grid gap-3 sm:grid-cols-2">{deletedProjects.map(project => <DeletedCollectionCard key={project.id} testId="trash-project"
        icon={<Briefcase className="h-6 w-6" aria-hidden="true" />} title={jobLabel(project)}
        detail={project.photo_count > 0 ? `${plural(project.photo_count, 'photo')} deleted with it` : 'No photos deleted with it'}
        restoreBefore={project.restore_before} restoreLabel="Restore project" busy={busy} restoring={restoring === project.id}
        onRestore={() => void restore('project', project)}
        onDeleteForever={() => setPending({
          request: { project_ids: [project.id] },
          title: `Delete project “${project.name}” forever?`,
          body: <><p>Every photo of this project still in Trash is deleted forever too, with its files.</p><p>This cannot be undone. Its number becomes free for a new project.</p></>,
          done: () => `Project “${project.name}” deleted forever`,
        })} />)}</div>
    </section>}

    {deletedAlbums.length > 0 && <section aria-label="Deleted albums" className="space-y-3">
      <h2 className="text-lg font-semibold">Albums · {deletedAlbums.length}</h2>
      <p className="text-base text-[#bbb]">Deleting an album never deletes its photos. Restoring brings the album back with them.</p>
      <div className="grid gap-3 sm:grid-cols-2">{deletedAlbums.map(album => <DeletedCollectionCard key={album.id} testId="trash-album"
        icon={<BookImage className="h-6 w-6" aria-hidden="true" />} title={album.name}
        restoreBefore={album.restore_before} restoreLabel="Restore album" busy={busy} restoring={restoring === album.id}
        onRestore={() => void restore('album', album)}
        onDeleteForever={() => setPending({
          request: { album_ids: [album.id] },
          title: `Delete album “${album.name}” forever?`,
          body: <><p>Only the album goes. Its photos stay in Photos.</p><p>This cannot be undone.</p></>,
          done: () => `Album “${album.name}” deleted forever`,
        })} />)}</div>
    </section>}

    <section aria-label="Trashed photos" className="space-y-3">
      {(photos.length > 0 || cursor) && <h2 className="text-lg font-semibold">Photos</h2>}
      <p role="status" className="text-sm text-[#bbb]">{isFetching ? 'Loading…' : photos.length > 0 ? `${plural(photos.length, 'photo')} on this page` : ''}</p>
      {photos.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <button className={`${button} ${tall}`} disabled={busy} onClick={() => setSelected(chosen.length === photos.length ? new Set() : new Set(photos.map(photo => photo.id)))}>
          {chosen.length === photos.length ? 'Clear selection' : 'Select all on this page'}
        </button>
        {chosen.length > 0 && <button className={forever} disabled={busy} onClick={() => setPending({
          request: { photo_ids: chosen },
          title: `Delete ${plural(chosen.length, 'photo')} forever?`,
          body: <><p>The {chosen.length === 1 ? 'photo and its file are' : 'photos and their files are'} removed for good.</p><p>This cannot be undone.</p></>,
          done: photosDeleted,
        })}>Delete {plural(chosen.length, 'photo')} forever</button>}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">{photos.map(photo => <article key={photo.id} data-testid="trash-photo" className={`space-y-3 rounded-xl border bg-[#2e2e2e] p-4 ${selected.has(photo.id) ? 'border-[#2680FC]' : 'border-[#444]'}`}>
        <div className="flex items-center gap-2">
          <label className="-ml-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
            <input type="checkbox" aria-label={`Select ${photoName(photo) ?? 'photo'}`} checked={selected.has(photo.id)} disabled={busy}
              onChange={() => toggle(photo.id)} className="h-5 w-5 accent-[#2680FC]" />
          </label>
          <ActionThumbnail photo={photo} /><div className="min-w-0">
          <h3 className="break-all text-base font-semibold">{photoName(photo) || 'Photo'}</h3>
          <p className="text-sm text-[#bbb]">{projectOf(photo)}</p>
        </div></div>
        <p className="text-sm text-amber-300">Restore before {day(photo.purge_after)}{photo.job?.deleted_at ? '. Restoring it alone puts it in “No project”; restore its project to bring it back there.' : ''}</p>
        {photo.duplicate_of && <div className="space-y-2 text-sm leading-relaxed text-[#bbb]"><p>This is a copy of another photo. Restoring brings back that original, so there is never a second copy.</p>
          {photo.canonical_photo && <p className="break-all">The original: {photoName(photo.canonical_photo) || 'Photo'} · {projectOf(photo.canonical_photo)} · {photo.canonical_photo.deleted_at ? 'in Trash' : 'in Photos'}</p>}
          {photo.canonical_photo && !photo.canonical_photo.deleted_at && <Link className="flex min-h-9 w-fit items-center text-[#8bbaff] underline" href={photoPath(photo.canonical_photo.job_id, photo.canonical_photo.id)}>View the original</Link>}
        </div>}
        <div className="flex flex-wrap gap-2">
          {photo.can_restore ? <Link href={`/photos/actions?action=restore&photo=${photo.id}`} className={`${button} ${tall} inline-flex items-center`}>Restore</Link> : <p className="text-sm text-[#bbb]">{photo.remedy ?? 'This photo can no longer be restored.'}</p>}
          <button className={forever} disabled={busy} onClick={() => setPending({
            request: { photo_ids: [photo.id] },
            title: 'Delete this photo forever?',
            body: <><p className="break-all">{photoName(photo) || 'The photo'} and its file are removed for good.</p><p>This cannot be undone.</p></>,
            done: photosDeleted,
          })}>Delete forever</button>
        </div>
      </article>)}</div>
      {(cursor || data?.next_cursor) && <div className="flex flex-wrap gap-3"><button className={`${button} ${tall}`} disabled={!cursor || isFetching} onClick={() => { setCursor(null); setSelected(new Set()); }}>First page</button><button className={`${button} ${tall}`} disabled={!data?.next_cursor || isFetching} onClick={() => { setCursor(data?.next_cursor ?? null); setSelected(new Set()); }}>Next page</button></div>}
    </section>
    <button className={`${button} ${tall}`} disabled={loading} onClick={refresh}>Refresh</button>

    <ConfirmDialog
      open={pending !== null}
      onOpenChange={open => { if (!open) setPending(null); }}
      title={pending?.title ?? ''}
      confirmLabel="Delete forever"
      busyLabel="Deleting..."
      busy={purging}
      onConfirm={() => { if (pending) void purge(pending); }}
    >
      {pending?.body}
    </ConfirmDialog>
  </main>;
}

/** One deleted project or album: restorable until restore_before, deletable forever at any time. */
function DeletedCollectionCard({ testId, icon, title, detail, restoreBefore, restoreLabel, busy, restoring, onRestore, onDeleteForever }: {
  testId: string; icon: ReactNode; title: string; detail?: string; restoreBefore: string; restoreLabel: string;
  busy: boolean; restoring: boolean; onRestore(): void; onDeleteForever(): void;
}) {
  const past = expired(restoreBefore);
  return <article data-testid={testId} className="flex flex-wrap items-center gap-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#3e3e3e] text-[#8bbaff]">{icon}</span>
    <div className="min-w-0 flex-1 basis-40">
      <h3 className="break-words text-base font-semibold">{title}</h3>
      {detail && <p className="text-sm text-[#bbb]">{detail}</p>}
      <p className="text-sm text-amber-300">{past ? 'Can no longer be restored' : `Restore before ${day(restoreBefore)}`}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      {!past && <button className={`${button} ${tall}`} disabled={busy} onClick={onRestore}>{restoring ? 'Restoring…' : restoreLabel}</button>}
      <button className={forever} disabled={busy} onClick={onDeleteForever}>Delete forever</button>
    </div>
  </article>;
}
