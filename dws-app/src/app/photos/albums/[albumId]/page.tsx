"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { BookImage, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import ShareButton from "@/components/photos/share-button";
import CollectionHeader, { headerActionClass } from "@/components/photos/collection-header";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary, emptySecondary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import {
  deleteAlbum,
  invalidatePhotoCaches,
  renameAlbum,
  usePhotoAlbum,
} from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

/** One album: its name (rename in place), count, delete, and its photos. */
export default function AlbumPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { openPicker } = usePhotosShell();
  const { data: album, error, isLoading } = usePhotoAlbum(albumId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!album) return;
    setDeleting(true);
    try {
      await deleteAlbum(album.id);
      invalidatePhotoCaches(queryClient);
      toast.success(`Album “${album.name}” deleted`, {
        description: "Its photos are still in Photos. You can restore the album from Trash for 30 days.",
      });
      router.push("/photos/albums");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to delete the album");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  if (!isLoading && (error || !album)) {
    return (
      <main className={PAGE_MAIN_CLASS}>
        <PhoneHeader back={{ href: "/photos/albums", label: "Albums" }} />
        <EmptyState
          icon={<BookImage className="h-7 w-7" aria-hidden="true" />}
          title="This album is not here"
          actions={
            <>
              <Link href="/photos/albums" className={emptyPrimary}>
                All albums
              </Link>
              <Link href="/photos/trash" className={emptySecondary}>
                Open Trash
              </Link>
            </>
          }
        >
          It may have been deleted. A deleted album can be restored from Trash for
          30 days, and its photos are still in Photos.
        </EmptyState>
      </main>
    );
  }

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader back={{ href: "/photos/albums", label: "Albums" }} />
      <CollectionHeader
        name={album?.name}
        fallbackName="Album"
        subtitle={album ? `Album · ${plural(album.photo_count, "photo")}` : " "}
        renameLabel="Album name"
        share={album && <ShareButton album={{ id: album.id, name: album.name }} />}
        onRename={async (name) => {
          await renameAlbum(albumId, name);
          invalidatePhotoCaches(queryClient);
        }}
        actions={
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className={headerActionClass}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete album
          </button>
        }
      />

      {album && (
        <PhotoBrowser
          scope={{ kind: "album", album: { id: album.id, name: album.name } }}
          empty={
            <EmptyState
              icon={<BookImage className="h-7 w-7" aria-hidden="true" />}
              title="This album is empty"
              actions={
                <button type="button" onClick={openPicker} className={emptyPrimary}>
                  <Upload className="h-5 w-5" aria-hidden="true" />
                  Upload photos to this album
                </button>
              }
            >
              Upload photos here, or pick photos anywhere in the app and choose
              “Add to album”.
            </EmptyState>
          }
        />
      )}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete album “${album?.name ?? "Album"}”? The photos stay in Photos.`}
        confirmLabel="Delete album"
        busyLabel="Deleting..."
        busy={deleting}
        onConfirm={() => void remove()}
      >
        <p>Only the album goes away. You can restore it from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
