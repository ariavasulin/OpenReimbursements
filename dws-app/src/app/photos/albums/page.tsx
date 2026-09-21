"use client";

import { BookImage, Plus } from "lucide-react";
import CollectionCard from "@/components/photos/collection-card";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { ALBUM_EXPLAINER } from "@/components/photos/new-album-sheet";
import {
  PAGE_MAIN_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
} from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import StatusLine from "@/components/photos/status-line";
import { usePhotoAlbums } from "@/lib/photos/api";

/** Albums: every album as a card, and "New album". */
export default function AlbumsPage() {
  const { openNewAlbum } = usePhotosShell();
  const { data: albums, isLoading, error } = usePhotoAlbums(true);

  const newAlbumButton = (
    <button type="button" onClick={openNewAlbum} className={emptyPrimary}>
      <Plus className="h-5 w-5" aria-hidden="true" />
      New album
    </button>
  );

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className={PAGE_TITLE_CLASS}>Albums</h1>
          <p className={PAGE_SUBTITLE_CLASS}>{ALBUM_EXPLAINER}</p>
        </div>
        {albums && albums.length > 0 && newAlbumButton}
      </div>

      {isLoading && <StatusLine>Loading albums...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load albums"}
        </StatusLine>
      )}
      {albums && albums.length === 0 && (
        <EmptyState
          icon={<BookImage className="h-7 w-7" aria-hidden="true" />}
          title="No albums yet"
          actions={newAlbumButton}
        >
          Make an album for anything that is not one project — a Christmas party,
          or the best photos from many projects for marketing.
        </EmptyState>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {albums?.map((album) => (
          <CollectionCard
            key={album.id}
            href={`/photos/albums/${album.id}`}
            name={album.name}
            photoCount={album.photo_count}
            thumbPaths={album.thumb_paths}
            emptyText="No photos yet"
          />
        ))}
      </div>
    </main>
  );
}
