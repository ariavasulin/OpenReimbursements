"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, BookImage, Upload } from "lucide-react";
import { toast } from "sonner";
import AlbumArrange from "@/components/photos/album-arrange";
import ShareButton from "@/components/photos/share-button";
import CollectionHeader, { headerActionClass } from "@/components/photos/collection-header";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary, emptySecondary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { PlayButton, SlideshowLink } from "@/components/photos/slideshow-link";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import {
  deleteAlbum,
  invalidateAlbumOrder,
  invalidatePhotoCaches,
  renameAlbum,
  restoreAlbumOrder,
  setAlbumDateOrder,
  usePhotoActor,
  photoKeys,
  usePhotoAlbum,
  type PhotoAlbumHeader,
  type PhotoSort,
} from "@/lib/photos/api";
import { MAX_ARRANGE_PHOTOS } from "@/lib/photos/apiShared";
import { canDeleteAlbum } from "@/lib/photos/permissions";
import { plural } from "@/lib/photos/format";

/**
 * Drop `sort` from the address bar, so the grid shows the album's own order
 * again. Only while that album's page is still up: a change that finishes
 * after moving to another album leaves that page's address alone.
 */
function showAlbumOrder(albumId: string) {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  if (!params.has("sort") || !pathname.endsWith(`/albums/${albumId}`)) return;
  params.delete("sort");
  const query = params.toString();
  window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}${hash}`);
}

/** One album: its name (rename in place), count, delete, and its photos. */
export default function AlbumPage() {
  // The header's Play button starts the viewer's slideshow (slideshow-link.tsx).
  return (
    <SlideshowLink>
      <AlbumPageContent />
    </SlideshowLink>
  );
}

function AlbumPageContent() {
  const { albumId } = useParams<{ albumId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { openPicker } = usePhotosShell();
  // Shown at once from the Albums list's card when that is cached (and says
  // the album's order), so the grid below starts loading without waiting.
  const { data: album, error, isLoading } = usePhotoAlbum(albumId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Arranging, from this order (null: not arranging). */
  const [arranging, setArranging] = useState<PhotoSort | null>(null);
  const actor = usePhotoActor();
  const canDelete = album !== undefined && canDeleteAlbum(actor, album);

  /** The album's mode as this page now knows it, ahead of the refetch. */
  const setMode = (mode: PhotoAlbumHeader["sort_mode"]) => {
    queryClient.setQueryData<PhotoAlbumHeader>(photoKeys.album(albumId), (current) =>
      current && { ...current, sort_mode: mode, has_custom_order: current.has_custom_order || mode === "custom" }
    );
    // Only this album's grid, header, and card show its order.
    invalidateAlbumOrder(queryClient, albumId);
  };

  const restoreCustom = async (name: string) => {
    try {
      await restoreAlbumOrder(albumId);
      setMode("custom");
      showAlbumOrder(albumId);
      toast.success(`“${name}” shows its arranged order again, for everyone`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to change the order");
    }
  };

  // Decision 9: an album has one order everyone sees, the share link included,
  // so Sort on an album page switches that order rather than this view's alone.
  const pickSort = async (sort: PhotoSort) => {
    if (!album) return;
    if (sort === "custom" && album.sort_mode !== "custom") {
      await restoreCustom(album.name);
    } else if (sort !== "custom" && album.sort_mode === "custom") {
      try {
        await setAlbumDateOrder(albumId);
        setMode("date");
        toast.success(`“${album.name}” now shows photos by date, for everyone`, {
          description: "Its arranged order is kept: choose Sort › Custom to bring it back.",
          action: { label: "Undo", onClick: () => void restoreCustom(album.name) },
        });
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : "Failed to change the order");
      }
    }
  };

  const startArranging = () => {
    if (!album) return;
    if (album.photo_count > MAX_ARRANGE_PHOTOS) {
      toast.error(`Only albums of up to ${plural(MAX_ARRANGE_PHOTOS, "photo")} can be arranged by hand`, {
        description: `This album has ${plural(album.photo_count, "photo")}.`,
      });
      return;
    }
    // Read here rather than followed: the viewer rewrites the address on every swipe.
    const viewSort = new URLSearchParams(window.location.search).get("sort");
    setArranging(album.has_custom_order ? "custom" : viewSort === "asc" ? "asc" : "desc");
  };

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

  if (album && arranging !== null) {
    return (
      <main className={PAGE_MAIN_CLASS}>
        <PhoneHeader back={{ href: "/photos/albums", label: "Albums" }} />
        <AlbumArrange
          album={album}
          startSort={arranging}
          onClose={(saved) => {
            setArranging(null);
            if (!saved) return;
            setMode("custom");
            showAlbumOrder(albumId);
            toast.success("Order saved", { description: "Everyone sees this order, including the share link." });
          }}
        />
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
        actions={
          album && (
            <>
              <PlayButton />
              <ShareButton album={{ id: album.id, name: album.name }} className={headerActionClass} />
              {album.photo_count > 1 && (
                <button type="button" onClick={startArranging} className={headerActionClass}>
                  <ArrowDownUp aria-hidden="true" />
                  Arrange
                </button>
              )}
            </>
          )
        }
        onRename={async (name) => {
          await renameAlbum(albumId, name);
          invalidatePhotoCaches(queryClient);
        }}
        remove={canDelete ? { label: "Delete album", onSelect: () => setConfirmingDelete(true) } : undefined}
      />

      {album && (
        <PhotoBrowser
          scope={{ kind: "album", album: { id: album.id, name: album.name } }}
          albumOrder={{
            defaultSort: album.sort_mode === "custom" ? "custom" : "desc",
            customOffered: album.has_custom_order,
            onSortPicked: (sort) => void pickSort(sort),
          }}
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
