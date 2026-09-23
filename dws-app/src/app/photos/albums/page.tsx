"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookImage, CheckSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import CollectionCard from "@/components/photos/collection-card";
import { headerActionClass } from "@/components/photos/collection-header";
import CollectionSelectBar from "@/components/photos/collection-select-bar";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { ALBUM_EXPLAINER } from "@/components/photos/new-album-sheet";
import {
  PAGE_MAIN_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
} from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import StatusLine from "@/components/photos/status-line";
import { deleteAlbum, invalidatePhotoCaches, renameAlbum, usePhotoAlbums } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

const ALBUMS_PER_PAGE = 60;

/** Albums: bounded card pages, "New album", and select to rename or delete. */
export default function AlbumsPage() {
  const queryClient = useQueryClient();
  const { openNewAlbum } = usePhotosShell();
  const { data: albums, isLoading, error } = usePhotoAlbums(true);
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil((albums?.length ?? 0) / ALBUMS_PER_PAGE));
  const page = Math.min(requestedPage, pageCount - 1);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const chosen = (albums ?? []).filter((album) => selected?.has(album.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async () => {
    setBusy(true);
    let deleted = 0;
    try {
      for (const album of chosen) {
        await deleteAlbum(album.id);
        deleted++;
      }
      toast.success(`${plural(deleted, "album")} deleted`, {
        description: "Their photos are still in Photos. You can restore the albums from Trash for 30 days.",
      });
      setSelected(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to delete the album", {
        description: deleted > 0 ? `${plural(deleted, "album")} deleted before this.` : undefined,
      });
    } finally {
      invalidatePhotoCaches(queryClient);
      setBusy(false);
      setConfirming(false);
    }
  };

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
        {albums && albums.length > 0 && selected === null && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSelected(new Set())} className={headerActionClass}>
              <CheckSquare className="h-4 w-4" aria-hidden="true" />
              Select
            </button>
            {newAlbumButton}
          </div>
        )}
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
        {albums?.slice(page * ALBUMS_PER_PAGE, (page + 1) * ALBUMS_PER_PAGE).map((album) => (
          <CollectionCard
            key={album.id}
            href={`/photos/albums/${album.id}`}
            name={album.name}
            photoCount={album.photo_count}
            thumbPaths={album.thumb_paths}
            emptyText="No photos yet"
            selection={selected ? { selected: selected.has(album.id), onToggle: () => toggle(album.id) } : undefined}
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

      {selected && (
        <CollectionSelectBar
          label="Selected albums"
          count={chosen.length}
          busy={busy}
          onClose={() => setSelected(null)}
          onRename={() => setRenaming(true)}
          onDelete={() => setConfirming(true)}
        />
      )}

      {chosen.length === 1 && (
        <RenameSheet
          open={renaming}
          onOpenChange={setRenaming}
          title="Rename album"
          nameLabel="Album name"
          name={chosen[0].name}
          onSave={async (name) => {
            await renameAlbum(chosen[0].id, name);
            invalidatePhotoCaches(queryClient);
            setSelected(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          chosen.length === 1
            ? `Delete album “${chosen[0].name}”?`
            : `Delete ${plural(chosen.length, "album")}?`
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        busy={busy}
        onConfirm={() => void remove()}
      >
        <p>Only the {chosen.length === 1 ? "album goes" : "albums go"} away. The photos stay in Photos.</p>
        <p>You can restore from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
