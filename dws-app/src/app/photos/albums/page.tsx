"use client";

import { useMemo, useState } from "react";
import { useCollectionSelect } from "@/hooks/use-collection-select";
import { useQueryClient } from "@tanstack/react-query";
import { BookImage, Plus } from "lucide-react";
import CollectionCard from "@/components/photos/collection-card";
import CollectionSelectBar from "@/components/photos/collection-select-bar";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import CollectionTitleRow from "@/components/photos/collection-sort-chip";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { CARD_GRID_CLASS, PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import StatusLine from "@/components/photos/status-line";
import { deleteAlbum, invalidatePhotoCaches, renameAlbum, usePhotoActor, usePhotoAlbums } from "@/lib/photos/api";
import { canDeleteAlbum } from "@/lib/photos/permissions";
import { plural } from "@/lib/photos/format";
import { ALBUM_SORT_OPTIONS, DEFAULT_ALBUM_SORT, parseAlbumSort, sortAlbums } from "@/lib/photos/collection-sort";
import { useCollectionSort } from "@/hooks/use-collection-sort";

const ALBUMS_PER_PAGE = 60;

/** Albums: bounded card pages in the order the Sort chip says (name, A to Z, by default); select (hover tick or press and hold) to rename or delete. New album lives in the "+" menu. */
export default function AlbumsPage() {
  const queryClient = useQueryClient();
  const { openNewAlbum } = usePhotosShell();
  const loaded = usePhotoAlbums(true);
  const [sort, setSort] = useCollectionSort(parseAlbumSort, DEFAULT_ALBUM_SORT);
  const albums = useMemo(() => loaded.data && sortAlbums(loaded.data, sort), [loaded.data, sort]);
  const { isLoading, error } = loaded;
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil((albums?.length ?? 0) / ALBUMS_PER_PAGE));
  const page = Math.min(requestedPage, pageCount - 1);
  const actor = usePhotoActor();
  const select = useCollectionSelect(albums, {
    noun: "album",
    deleteOne: deleteAlbum,
    deletedDescription: "Their photos are still in Photos. You can restore the albums from Trash for 30 days.",
    canDelete: (album) => canDeleteAlbum(actor, album),
  });
  const { chosen, deletable } = select;

  const newAlbumButton = (
    <button type="button" onClick={openNewAlbum} className={emptyPrimary}>
      <Plus className="h-5 w-5" aria-hidden="true" />
      New album
    </button>
  );

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <CollectionTitleRow title="Albums" options={ALBUM_SORT_OPTIONS} value={sort} onChange={setSort} />

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

      <div className={CARD_GRID_CLASS}>
        {albums?.slice(page * ALBUMS_PER_PAGE, (page + 1) * ALBUMS_PER_PAGE).map((album) => (
          <CollectionCard
            key={album.id}
            href={`/photos/albums/${album.id}`}
            name={album.name}
            photoCount={album.photo_count}
            thumbPaths={album.thumb_paths}
            emptyText="No photos yet"
            selection={select.card(album.id)}
            prefetch={{ kind: "album", id: album.id }}
          />
        ))}
      </div>
      {pageCount > 1 && (
        <nav aria-label="Album pages" className="mt-5 flex items-center justify-center gap-4 text-sm">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}
            className="min-h-11 rounded border border-[#4e4e4e] px-4 disabled:opacity-40">Previous</button>
          <span aria-live="polite">Page {page + 1} of {pageCount}</span>
          <button type="button" disabled={page + 1 === pageCount} onClick={() => setPage(page + 1)}
            className="min-h-11 rounded border border-[#4e4e4e] px-4 disabled:opacity-40">Next</button>
        </nav>
      )}

      {select.selecting && (
        <CollectionSelectBar
          label="Selected albums"
          count={chosen.length}
          deletable={deletable.length}
          busy={select.busy}
          onClose={select.stop}
          onRename={() => select.setRenaming(true)}
          onDelete={() => select.setConfirming(true)}
        />
      )}

      {chosen.length === 1 && (
        <RenameSheet
          open={select.renaming}
          onOpenChange={select.setRenaming}
          title="Rename album"
          nameLabel="Album name"
          name={chosen[0].name}
          onSave={async (name) => {
            await renameAlbum(chosen[0].id, name);
            invalidatePhotoCaches(queryClient);
            select.stop();
          }}
        />
      )}

      <ConfirmDialog
        open={select.confirming}
        onOpenChange={select.setConfirming}
        title={
          deletable.length === 1
            ? `Delete album “${deletable[0].name}”?`
            : `Delete ${plural(deletable.length, "album")}?`
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        busy={select.busy}
        onConfirm={() => void select.remove()}
      >
        <p>Only the {deletable.length === 1 ? "album goes" : "albums go"} away. The photos stay in Photos.</p>
        <p>You can restore from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
