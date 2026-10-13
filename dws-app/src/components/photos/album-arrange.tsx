"use client";

import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { FileText, Play, Video } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";
import { MAX_ARRANGE_PHOTOS } from "@/lib/photos/apiShared";
import {
  fetchPhotosPage,
  saveAlbumOrder,
  type PhotoAlbumHeader,
  type PhotoSort,
} from "@/lib/photos/api";
import { photoName, plural } from "@/lib/photos/format";
import { publicUrl } from "@/lib/photos/urls";
import type { PhotoRow } from "@/lib/photos/types";
import { PAGE_SUBTITLE_CLASS, PAGE_TITLE_CLASS } from "@/components/photos/page-layout";
import StatusLine from "@/components/photos/status-line";
import { cn } from "@/lib/utils";

// Arrange: the album's whole order, by hand. The album loads in full (at most
// MAX_ARRANGE_PHOTOS), every tile can be dragged — press and hold on a phone,
// drag with the mouse on a computer, or Space and the arrow keys — and Done
// saves the order for everyone. Cancel throws the changes away.

/** Rows one load step asks for: GET /api/photos's largest page. */
const LOAD_PAGE = 200;

/**
 * The mouse and pen half of dragging: a 5 px move starts it. Touch is left to
 * TouchSensor, whose press-and-hold leaves a quick swipe free to scroll.
 */
class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: event }: ReactPointerEvent) =>
        event.isPrimary && event.button === 0 && event.pointerType !== "touch",
    },
  ];
}

/** Every photo in the album, in `sort` order; null once it turns out to be too many. */
async function loadAlbum(albumId: string, sort: PhotoSort, signal: AbortSignal): Promise<PhotoRow[] | null> {
  const photos: PhotoRow[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ album: albumId, limit: String(LOAD_PAGE) });
    if (sort !== "desc") params.set("sort", sort);
    if (cursor) params.set("cursor", cursor);
    const page = await fetchPhotosPage(params);
    if (signal.aborted) return [];
    photos.push(...page.photos);
    if (photos.length > MAX_ARRANGE_PHOTOS) return null;
    cursor = page.nextCursor;
  } while (cursor);
  return photos;
}

/** What a tile shows: the thumbnail, or an icon and name for a file or a video still processing. */
function TileFace({ photo, place }: { photo: PhotoRow; place: number }) {
  const name = photoName(photo) ?? photo.kind;
  return (
    <>
      {photo.thumb_path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={publicUrl(photo.thumb_path)}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
          {photo.kind === "video" ? (
            <Video className="h-5 w-5 text-[#a0a0a0]" aria-hidden="true" />
          ) : (
            <FileText className="h-5 w-5 text-[#a0a0a0]" aria-hidden="true" />
          )}
          <span className="line-clamp-2 w-full break-all text-[11px] text-[#b4b4b4]">{name}</span>
        </span>
      )}
      {photo.kind === "video" && photo.thumb_path && (
        <span className="absolute bottom-1 right-1 rounded bg-black/65 p-1 text-white">
          <Play className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
        </span>
      )}
      <span className="absolute left-1 top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-black/65 px-1.5 text-xs font-semibold text-white">
        {place}
      </span>
    </>
  );
}

const tileClass =
  "relative aspect-square select-none overflow-hidden rounded-md bg-[#2e2e2e] [-webkit-touch-callout:none]";

function SortableTile({ photo, place, disabled }: { photo: PhotoRow; place: number; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: photo.id,
    disabled,
  });
  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-label={`${place}. ${photoName(photo) ?? photo.kind}`}
      // A long press would otherwise open the phone's image menu.
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        tileClass,
        "cursor-grab touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] focus-visible:ring-offset-2 focus-visible:ring-offset-[#222222]",
        isDragging && "opacity-30"
      )}
    >
      <TileFace photo={photo} place={place} />
    </div>
  );
}

export default function AlbumArrange({
  album,
  startSort: startSortProp,
  onClose,
}: {
  album: PhotoAlbumHeader;
  /** The order to start from: the saved custom order if there is one, else the page's date order. */
  startSort: PhotoSort;
  /** `saved`: the album now shows the new order. */
  onClose(saved: boolean): void;
}) {
  const isDesktop = useDesktop();
  // Fixed when Arrange opens: a refresh of the album's header while someone is
  // arranging (another person saved an order) must not reload over their draft.
  const [startSort] = useState(startSortProp);
  const [loaded, setLoaded] = useState<PhotoRow[] | null>(null);
  const [order, setOrder] = useState<PhotoRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAlbum(album.id, startSort, controller.signal).then(
      (photos) => {
        if (controller.signal.aborted) return;
        if (photos === null) {
          setLoadError(
            `Only albums of up to ${plural(MAX_ARRANGE_PHOTOS, "photo")} can be arranged by hand.`
          );
          return;
        }
        setLoaded(photos);
        setOrder(photos);
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setLoadError(reason instanceof Error ? reason.message : "Failed to load the album");
        }
      }
    );
    return () => controller.abort();
  }, [album.id, startSort]);

  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const ids = useMemo(() => order.map((photo) => photo.id), [order]);
  const active = activeId ? order.find((photo) => photo.id === activeId) : undefined;
  const changed = loaded !== null && order.some((photo, index) => photo.id !== loaded[index]?.id);

  const onDragStart = ({ active: dragged }: DragStartEvent) => {
    setActiveId(String(dragged.id));
    navigator.vibrate?.(10);
  };
  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || dragged.id === over.id) return;
    setOrder((current) => {
      const from = current.findIndex((photo) => photo.id === dragged.id);
      const to = current.findIndex((photo) => photo.id === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  };

  const done = async () => {
    // Nothing moved and nothing to switch: the album already shows this order.
    if (!changed && (startSort === "custom") === (album.sort_mode === "custom")) {
      onClose(false);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await saveAlbumOrder(album.id, ids);
      onClose(true);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      // The server's only refusal of a well-formed order: the album's photos
      // changed (added, removed, or trashed) since it was opened here.
      setSaveError(
        message === "Invalid request."
          ? "The album's photos changed while you were arranging, so the order was not saved. Cancel and arrange again."
          : message || "Failed to save the order"
      );
      setSaving(false);
    }
  };

  return (
    <section aria-label="Arrange album">
      <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#3e3e3e] bg-[#222222]/95 py-3 backdrop-blur">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className={PAGE_TITLE_CLASS}>Arrange “{album.name}”</h1>
          <p className={PAGE_SUBTITLE_CLASS}>
            {isDesktop
              ? "Drag photos into the order you want. Everyone sees this order, including the share link."
              : "Press and hold a photo, then drag it. Everyone sees this order, including the share link."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onClose(false)}
            disabled={saving}
            className="min-h-11 rounded-lg px-4 text-base text-[#d0d0d0] hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void done()}
            disabled={saving || loaded === null}
            className="min-h-11 rounded-lg bg-[#2680FC] px-5 text-base font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Done"}
          </button>
        </div>
        {saveError && (
          <p role="alert" className="w-full text-sm text-red-300">
            {saveError}
          </p>
        )}
      </div>

      {loadError ? (
        <StatusLine error>{loadError}</StatusLine>
      ) : loaded === null ? (
        <StatusLine>Loading every photo in the album...</StatusLine>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 desktop:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] desktop:gap-2">
              {order.map((photo, index) => (
                <SortableTile key={photo.id} photo={photo} place={index + 1} disabled={saving} />
              ))}
            </div>
          </SortableContext>
          <DragOverlay>
            {active && (
              <div className={cn(tileClass, "scale-105 cursor-grabbing shadow-2xl ring-2 ring-[#2680FC]")}>
                <TileFace photo={active} place={order.indexOf(active) + 1} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </section>
  );
}
