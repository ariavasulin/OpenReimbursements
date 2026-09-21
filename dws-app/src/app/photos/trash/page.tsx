'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage } from 'lucide-react';
import { toast } from 'sonner';
import { fetchDeletedAlbums, fetchJson, invalidatePhotoCaches, restoreAlbum, type DeletedAlbum } from '@/lib/photos/api';
import { actionButton as button, trashDisclosure } from '@/lib/photos/action-client';
import type { TrashResponse } from '@/lib/photos/action-types';
import ActionThumbnail from '@/components/photos/action-thumbnail';
import { jobLabel, NO_PROJECT, plural } from '@/lib/photos/format';
import { photoPath } from '@/lib/photos/photo-link';

const tall = 'min-h-11 text-base';
const day = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the 30-day limit';

/** Trash: deleted albums and trashed photos, each restorable for 30 days. */
export default function TrashPage() {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['photo-trash', cursor],
    queryFn: () => fetchJson<TrashResponse>(`/api/photos/trash?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, 'Could not load the trash', { cache: 'no-store' }),
    staleTime: 0,
  });
  const albums = useQuery({ queryKey: ['photo-albums-deleted'], queryFn: fetchDeletedAlbums, staleTime: 0 });

  const restore = async (album: DeletedAlbum) => {
    setRestoring(album.id);
    try {
      await restoreAlbum(album.id);
      invalidatePhotoCaches(queryClient);
      toast.success(`Album “${album.name}” restored`, { description: 'It is back under Albums with its photos.' });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Failed to restore the album');
    } finally {
      setRestoring(null);
    }
  };

  const photos = data?.photos ?? [];
  const nothing = !isFetching && !error && !albums.isFetching && photos.length === 0 && (albums.data?.length ?? 0) === 0 && !cursor;

  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-5 pb-40 sm:px-8">
    <Link href="/photos" className="desktop:hidden -ml-2 flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-base font-medium text-[#8bbaff]"><span aria-hidden="true">&lsaquo;</span>DWS Photos</Link>
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold">Trash</h1>
      <p className="max-w-3xl text-base leading-relaxed text-[#bbb]">{trashDisclosure} Anyone signed in can restore. After 30 days a photo is gone for good.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-base text-red-300">{error.message}</p>}
    {albums.error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-base text-red-300">{albums.error.message}</p>}

    {nothing && <p className="rounded-xl bg-[#2e2e2e] p-5 text-base text-[#bbb]">The trash is empty.</p>}

    {(albums.data?.length ?? 0) > 0 && <section aria-label="Deleted albums" className="space-y-3">
      <h2 className="text-lg font-semibold">Albums · {albums.data!.length}</h2>
      <p className="text-base text-[#bbb]">Deleting an album never deletes its photos. Restoring brings the album back with them.</p>
      <div className="grid gap-3 sm:grid-cols-2">{albums.data!.map(album => <article key={album.id} data-testid="trash-album" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#3e3e3e] text-[#8bbaff]"><BookImage className="h-6 w-6" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="break-words text-base font-semibold">{album.name}</h3>
          <p className="text-sm text-amber-300">Restore before {day(album.restore_before)}</p>
        </div>
        <button className={`${button} ${tall}`} disabled={restoring !== null} onClick={() => void restore(album)}>{restoring === album.id ? 'Restoring…' : 'Restore album'}</button>
      </article>)}</div>
    </section>}

    <section aria-label="Trashed photos" className="space-y-3">
      {(photos.length > 0 || cursor) && <h2 className="text-lg font-semibold">Photos</h2>}
      <p role="status" className="text-sm text-[#bbb]">{isFetching ? 'Loading…' : photos.length > 0 ? `${plural(photos.length, 'photo')} on this page` : ''}</p>
      <div className="grid gap-3 sm:grid-cols-2">{photos.map(photo => <article key={photo.id} data-testid="trash-photo" className="space-y-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
        <div className="flex items-center gap-3"><ActionThumbnail photo={photo} /><div className="min-w-0">
          <h3 className="break-all text-base font-semibold">{photo.original_name || 'Photo'}</h3>
          <p className="text-sm text-[#bbb]">{photo.job_id === null ? NO_PROJECT : photo.job ? jobLabel(photo.job) : 'A project'}</p>
        </div></div>
        <p className="text-sm text-amber-300">Restore before {day(photo.purge_after)}</p>
        {photo.duplicate_of && <div className="space-y-2 text-sm leading-relaxed text-[#bbb]"><p>This is a copy of another photo. Restoring brings back that original, so there is never a second copy.</p>
          {photo.canonical_photo && <p className="break-all">The original: {photo.canonical_photo.original_name || 'Photo'} · {photo.canonical_photo.job_id === null ? NO_PROJECT : photo.canonical_photo.job ? jobLabel(photo.canonical_photo.job) : 'a project'} · {photo.canonical_photo.deleted_at ? 'in Trash' : 'in Photos'}</p>}
          {photo.canonical_photo && !photo.canonical_photo.deleted_at && <Link className="flex min-h-9 w-fit items-center text-[#8bbaff] underline" href={photoPath(photo.canonical_photo.job_id, photo.canonical_photo.id)}>View the original</Link>}
        </div>}
        {photo.can_restore ? <Link href={`/photos/actions?action=restore&photo=${photo.id}`} className={`${button} ${tall} inline-flex items-center`}>Restore</Link> : <p className="text-sm text-[#bbb]">{photo.remedy ?? 'This photo can no longer be restored.'}</p>}
      </article>)}</div>
      {(cursor || data?.next_cursor) && <div className="flex flex-wrap gap-3"><button className={`${button} ${tall}`} disabled={!cursor || isFetching} onClick={() => setCursor(null)}>First page</button><button className={`${button} ${tall}`} disabled={!data?.next_cursor || isFetching} onClick={() => setCursor(data?.next_cursor ?? null)}>Next page</button></div>}
    </section>
    <button className={`${button} ${tall}`} disabled={isFetching} onClick={() => { void refetch(); void albums.refetch(); }}>Refresh</button>
  </main>;
}
