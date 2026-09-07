'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/photos/api';
import { actionButton as button, trashDisclosure } from '@/lib/photos/action-client';
import type { TrashResponse } from '@/lib/photos/action-types';
import ActionThumbnail from '@/components/photos/action-thumbnail';

export default function TrashPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['photo-trash', cursor],
    queryFn: () => fetchJson<TrashResponse>(`/api/photos/trash?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, 'Could not load trash', { cache: 'no-store' }),
    staleTime: 0,
  });
  return <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 pb-40 sm:px-8">
    <Link href="/photos" className="text-sm text-[#8bbaff]">DWS Photos</Link>
    <header className="space-y-3"><h1 className="text-2xl font-semibold">Photo trash</h1>
      <p className="max-w-3xl text-sm leading-6 text-[#bbb]">{trashDisclosure} Restore before the date shown to return a photo to the library.</p>
      <p className="text-sm leading-6 text-[#bbb]">You can restore photos you uploaded; administrators can restore anyone’s photos. Broader access requires an MCP restore handoff. Expired photos are no longer recoverable here.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">{error.message}</p>}
    <button className={button} disabled={isFetching} onClick={() => void refetch()}>Refresh trash</button>
    <p role="status" className="text-sm text-[#bbb]">{isFetching ? 'Loading trash…' : `${data?.photos.length ?? 0} recoverable ${data?.photos.length === 1 ? 'photo' : 'photos'} on this page`}</p>
    {!isFetching && !error && data?.photos.length === 0 && <p className="rounded-xl bg-[#2e2e2e] p-5 text-sm text-[#bbb]">No recoverable photos in this part of the trash.</p>}
    <div className="space-y-3">{data?.photos.map(photo => <article key={photo.id} data-testid="trash-photo" className="space-y-3 rounded-xl border border-[#444] bg-[#2e2e2e] p-4">
      <div className="flex items-center gap-3"><ActionThumbnail photo={photo} /><h2 className="min-w-0 break-all font-semibold">{photo.original_name || 'Photo'}</h2></div>
      <p className="text-sm text-[#bbb]">Job {photo.job ? `${photo.job.job_number} · ${photo.job.name}` : 'unavailable'}</p>
      <p className="text-sm text-amber-300">Restore before {photo.purge_after ? new Date(photo.purge_after).toLocaleString() : 'the retention deadline'}.</p>
      {photo.duplicate_of && <div className="space-y-2 text-sm leading-6 text-[#bbb]"><p>This legacy duplicate points to a canonical photo. Restoring uses that photo and never creates a second active copy.</p>
        {photo.canonical_photo && <p className="break-all">Canonical: {photo.canonical_photo.original_name || 'Photo'} · Job {photo.canonical_photo.job?.job_number ?? 'unavailable'} · {photo.canonical_photo.deleted_at ? 'In trash' : 'Active'}</p>}
        {photo.canonical_photo && !photo.canonical_photo.deleted_at && <Link className="inline-block text-[#8bbaff] underline" href={`/photos/${photo.canonical_photo.job_id}?photo=${photo.canonical_photo.id}`}>View canonical photo</Link>}
      </div>}
      {photo.can_restore ? <Link href={`/photos/actions?action=restore&photo=${photo.id}`} className={`${button} inline-block`}>Review restore</Link> : <p className="text-sm text-[#bbb]">{photo.remedy ?? 'Ask an administrator to restore this photo, or use the MCP restore handoff.'}</p>}
    </article>)}</div>
    <div className="flex flex-wrap gap-3"><button className={button} disabled={!cursor || isFetching} onClick={() => setCursor(null)}>First page</button><button className={button} disabled={!data?.next_cursor || isFetching} onClick={() => setCursor(data?.next_cursor ?? null)}>Next page</button></div>
  </main>;
}
