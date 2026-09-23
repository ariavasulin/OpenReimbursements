'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Briefcase } from 'lucide-react';
import { toast } from 'sonner';
import { fetchDeletedAlbums, fetchDeletedJobs, fetchJson, invalidatePhotoCaches, purgeTrash, restoreAlbum, restoreJob,
  type DeletedAlbum, type DeletedJob, type PurgeRequest } from '@/lib/photos/api';
import { actionButton as button, trashDisclosure } from '@/lib/photos/action-client';
import type { TrashResponse } from '@/lib/photos/action-types';
import ActionThumbnail from '@/components/photos/action-thumbnail';
import ConfirmDialog from '@/components/photos/confirm-dialog';
import { jobLabel, NO_PROJECT, photoName, plural } from '@/lib/photos/format';
import { photoPath } from '@/lib/photos/photo-link';

const tall = 'min-h-11 text-base';
const forever = `${button} ${tall} border-red-900 text-red-200 hover:border-red-400`;
const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the 30-day limit';

/** One "Delete forever" awaiting its confirmation. */
type PendingPurge = { request: PurgeRequest; title: string; body: ReactNode; done: string };

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
  const { data, error, isFetching, refetch } = useQuery({
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

  const purge = async ({ request, done }: PendingPurge) => {
    setPurging(true);
    const id = toast.loading('Deleting forever...');
    try {
      const { stuck } = await purgeTrash(request, (removed, remaining) => {
        if (remaining > 0) toast.loading(`Deleting forever... ${removed} removed, ${remaining} to go`, { id });
      });
      if (stuck > 0) {
        toast.warning(`${plural(stuck, 'photo')} could not be removed yet`, { id,
          description: 'They are out of Trash and cannot be restored. Press Empty trash later to finish.' });
      } else {
        toast.success(done, { id });
      }
      setSelected(new Set());
      setCursor(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Failed to delete forever', { id });
    } finally {
      refresh();
      setPurging(false);
      setPending(null);
    }
  };

  const photos = data?.photos ?? [];
  const deletedAlbums = albums.data ?? [];
  const deletedProjects = projects.data ?? [];
  const loading = isFetching || albums.isFetching || projects.isFetching;
  const nothing = !loading && !error && photos.length === 0 && deletedAlbums.length === 0 && deletedProjects.length === 0 && !cursor;
  const busy = purging || restoring !== null;
  const toggle = (photoId: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(photoId)) next.delete(photoId); else next.add(photoId);
    return next;
  });

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
        body: <><p>Every project, album, and photo in Trash is deleted forever, with the photo files.</p><p>This cannot be undone.</p></>,
        done: 'Trash emptied',
      })}>Empty trash</button>
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-base text-red-300">{error.message}</p>}
    {albums.error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-base text-red-300">{albums.error.message}</p>}
    {projects.error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-base text-red-300">{projects.error.message}</p>}

    {nothing && <p className="rounded-xl bg-[#2e2e2e] p-5 text-base text-[#bbb]">The trash is empty.</p>}

    {deletedProjects.length > 0 && <section aria-label="Deleted projects" className="space-y-3">
      <h2 className="text-lg font-semibold">Projects · {deletedProjects.length}</h2>
      <p className="text-base text-[#bbb]">A deleted project took its photos to Trash with it. Restoring brings them back together.</p>
      <div className="grid gap-3 sm:grid-cols-2">{deletedProjects.map(project => <article key={project.id} data-testid="trash-project" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#3e3e3e] text-[#8bbaff]"><Briefcase className="h-6 w-6" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="break-words text-base font-semibold">{jobLabel(project)}</h3>
          <p className="text-sm text-[#bbb]">{plural(project.photo_count, 'photo')} in Trash</p>
          <p className="text-sm text-amber-300">Restore before {day(project.restore_before)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={`${button} ${tall}`} disabled={busy} onClick={() => void restore('project', project)}>{restoring === project.id ? 'Restoring…' : 'Restore project'}</button>
          <button className={forever} disabled={busy} onClick={() => setPending({
            request: { project_ids: [project.id] },
            title: `Delete project “${project.name}” forever?`,
            body: <><p>{project.photo_count > 0 ? `Its ${plural(project.photo_count, 'photo')} in Trash are deleted forever too, with their files.` : 'It has no photos in Trash.'}</p><p>This cannot be undone. Its number becomes free for a new project.</p></>,
            done: `Project “${project.name}” deleted forever`,
          })}>Delete forever</button>
        </div>
      </article>)}</div>
    </section>}

    {deletedAlbums.length > 0 && <section aria-label="Deleted albums" className="space-y-3">
      <h2 className="text-lg font-semibold">Albums · {deletedAlbums.length}</h2>
      <p className="text-base text-[#bbb]">Deleting an album never deletes its photos. Restoring brings the album back with them.</p>
      <div className="grid gap-3 sm:grid-cols-2">{deletedAlbums.map(album => <article key={album.id} data-testid="trash-album" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#3e3e3e] text-[#8bbaff]"><BookImage className="h-6 w-6" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="break-words text-base font-semibold">{album.name}</h3>
          <p className="text-sm text-amber-300">Restore before {day(album.restore_before)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={`${button} ${tall}`} disabled={busy} onClick={() => void restore('album', album)}>{restoring === album.id ? 'Restoring…' : 'Restore album'}</button>
          <button className={forever} disabled={busy} onClick={() => setPending({
            request: { album_ids: [album.id] },
            title: `Delete album “${album.name}” forever?`,
            body: <><p>Only the album goes. Its photos stay in Photos.</p><p>This cannot be undone.</p></>,
            done: `Album “${album.name}” deleted forever`,
          })}>Delete forever</button>
        </div>
      </article>)}</div>
    </section>}

    <section aria-label="Trashed photos" className="space-y-3">
      {(photos.length > 0 || cursor) && <h2 className="text-lg font-semibold">Photos</h2>}
      <p role="status" className="text-sm text-[#bbb]">{isFetching ? 'Loading…' : photos.length > 0 ? `${plural(photos.length, 'photo')} on this page` : ''}</p>
      {photos.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <button className={`${button} ${tall}`} disabled={busy} onClick={() => setSelected(selected.size === photos.length ? new Set() : new Set(photos.map(photo => photo.id)))}>
          {selected.size === photos.length ? 'Clear selection' : 'Select all on this page'}
        </button>
        {selected.size > 0 && <button className={forever} disabled={busy} onClick={() => setPending({
          request: { photo_ids: [...selected] },
          title: `Delete ${plural(selected.size, 'photo')} forever?`,
          body: <><p>The {selected.size === 1 ? 'photo and its file are' : 'photos and their files are'} removed for good.</p><p>This cannot be undone.</p></>,
          done: `${plural(selected.size, 'photo')} deleted forever`,
        })}>Delete {plural(selected.size, 'photo')} forever</button>}
      </div>}
      <div className="grid gap-3 sm:grid-cols-2">{photos.map(photo => <article key={photo.id} data-testid="trash-photo" className={`space-y-3 rounded-xl border bg-[#2e2e2e] p-4 ${selected.has(photo.id) ? 'border-[#2680FC]' : 'border-[#444]'}`}>
        <div className="flex items-center gap-3">
          <input type="checkbox" aria-label={`Select ${photoName(photo) ?? 'photo'}`} checked={selected.has(photo.id)} disabled={busy}
            onChange={() => toggle(photo.id)} className="h-5 w-5 shrink-0 accent-[#2680FC]" />
          <ActionThumbnail photo={photo} /><div className="min-w-0">
          <h3 className="break-all text-base font-semibold">{photoName(photo) || 'Photo'}</h3>
          <p className="text-sm text-[#bbb]">{photo.job_id === null ? NO_PROJECT : photo.job ? jobLabel(photo.job) : 'A project'}</p>
        </div></div>
        <p className="text-sm text-amber-300">Restore before {day(photo.purge_after)}</p>
        {photo.duplicate_of && <div className="space-y-2 text-sm leading-relaxed text-[#bbb]"><p>This is a copy of another photo. Restoring brings back that original, so there is never a second copy.</p>
          {photo.canonical_photo && <p className="break-all">The original: {photoName(photo.canonical_photo) || 'Photo'} · {photo.canonical_photo.job_id === null ? NO_PROJECT : photo.canonical_photo.job ? jobLabel(photo.canonical_photo.job) : 'a project'} · {photo.canonical_photo.deleted_at ? 'in Trash' : 'in Photos'}</p>}
          {photo.canonical_photo && !photo.canonical_photo.deleted_at && <Link className="flex min-h-9 w-fit items-center text-[#8bbaff] underline" href={photoPath(photo.canonical_photo.job_id, photo.canonical_photo.id)}>View the original</Link>}
        </div>}
        <div className="flex flex-wrap gap-2">
          {photo.can_restore ? <Link href={`/photos/actions?action=restore&photo=${photo.id}`} className={`${button} ${tall} inline-flex items-center`}>Restore</Link> : <p className="text-sm text-[#bbb]">{photo.remedy ?? 'This photo can no longer be restored.'}</p>}
          <button className={forever} disabled={busy} onClick={() => setPending({
            request: { photo_ids: [photo.id] },
            title: 'Delete this photo forever?',
            body: <><p className="break-all">{photoName(photo) || 'The photo'} and its file are removed for good.</p><p>This cannot be undone.</p></>,
            done: 'Photo deleted forever',
          })}>Delete forever</button>
        </div>
      </article>)}</div>
      {(cursor || data?.next_cursor) && <div className="flex flex-wrap gap-3"><button className={`${button} ${tall}`} disabled={!cursor || isFetching} onClick={() => { setCursor(null); setSelected(new Set()); }}>First page</button><button className={`${button} ${tall}`} disabled={!data?.next_cursor || isFetching} onClick={() => { setCursor(data?.next_cursor ?? null); setSelected(new Set()); }}>Next page</button></div>}
    </section>
    <button className={`${button} ${tall}`} disabled={loading} onClick={() => { void refetch(); void albums.refetch(); void projects.refetch(); }}>Refresh</button>

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
