"use client";

import { memo, useCallback, useMemo, useRef } from "react";
import { Check, Download, FileText, Heart, Play, Video } from "lucide-react";
import {
  formatBytes,
  formatCaptureDay,
  formatDuration,
  photoName,
  plural,
} from "@/lib/photos/format";
import { useDesktop } from "@/hooks/use-desktop";
import { usePhotoActor } from "@/lib/photos/api";
import { useLongPress } from "@/hooks/use-long-press";
import { fileTypeLabel } from "@/lib/photos/file-type";
import { DESKTOP_TILES, PHONE_TILES, sectionHeightGuess } from "@/lib/photos/grid-layout";
import { isOpenable, type GroupBy, type PhotoGroup } from "@/lib/photos/group";
import { downloadUrl, publicUrl } from "@/lib/photos/urls";
import type { PhotoRow } from "@/lib/photos/types";
import { isFavorite } from "@/lib/photos/types";
import { cn } from "@/lib/utils";

/**
 * Select-many, owned by the page (usePhotoSelection) and drawn here. Phone:
 * press and hold a photo to start, then tap others. Desktop: a tick box on
 * hover, shift-click for a range, and a tick in each group header.
 */
export interface GridSelection {
  selectedIds: ReadonlySet<string>;
  /** `range`: shift was held, so select from the last tick to this photo. */
  onToggle(photo: PhotoRow, options: { range: boolean }): void;
  onToggleGroup(group: PhotoGroup): void;
}

interface PhotoGridProps {
  /** Precomputed via groupPhotos — the page shares them with the lightbox. */
  groups: PhotoGroup[];
  groupBy?: GroupBy;
  /** Tapping an image tile. */
  onOpenPhoto?: OnOpen;
  /** Omit for a grid that cannot select. */
  selection?: GridSelection;
  /**
   * Display rule, not a special flag: when set (e.g. "professional") and
   * grouping by date, photos carrying the tag get a pinned section on top.
   */
  pinnedTag?: string;
  pinnedLabel?: string;
  /** Tapping the pinned header — the page filters to the pinned tag. */
  onExpandPinned?: () => void;
}

type OnOpen = (photo: PhotoRow) => void;
type OnToggle = GridSelection["onToggle"];

/** The round tick shown on a tile, in a group header, and on an album or project card. */
export function Tick({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-full border-2 shadow",
        checked
          ? "border-[#2680FC] bg-[#2680FC] text-white"
          : "border-white bg-black/45 text-transparent",
        className
      )}
    >
      <Check className="h-4 w-4" strokeWidth={3} />
    </span>
  );
}

/** A small corner label on a tile: a video's duration, a file's type. */
const tilePillClass = "absolute rounded bg-black/65 px-[5px] py-px text-[11px] font-medium text-white";

/** The reader's heart, bottom-left: clear of the tick (top-left), the type pill
 * (top-right), and a video's length or a file's download (bottom-right). */
function FavoriteBadge() {
  return (
    <span
      aria-label="Favorite"
      role="img"
      className="pointer-events-none absolute bottom-1 left-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/55"
    >
      <Heart className="h-3 w-3 fill-[#FF4D6D] text-[#FF4D6D]" aria-hidden="true" />
    </span>
  );
}

interface TileProps {
  photo: PhotoRow;
  onOpen?: OnOpen;
  isDesktop: boolean;
  /** Absent for a grid that cannot select. Keeps one identity across renders. */
  onToggle?: OnToggle;
  selected: boolean;
  /** Anything in the grid is selected: taps tick instead of opening. */
  selecting: boolean;
  /** One of the reader's favorites: a small heart in the corner. */
  favorite: boolean;
}

// Memoized, with plain props: a tick, a viewer swipe, or a new page re-renders
// only the tiles whose own props changed, not every loaded tile. So every prop
// here must keep its identity between renders when nothing about this tile
// changed (the photo object itself, stable callbacks, booleans).
const Tile = memo(function Tile({
  photo,
  onOpen,
  isDesktop,
  onToggle,
  selected,
  selecting,
  favorite,
}: TileProps) {
  const name = photoName(photo) ?? photo.kind;

  // Press and hold (phone layout) starts selecting.
  const { handlers: pressHandlers, takeHold } = useLongPress(
    onToggle && !isDesktop ? () => onToggle(photo, { range: false }) : null
  );

  const handleClick = (event: React.MouseEvent<HTMLElement>, open: boolean) => {
    if (takeHold()) return;
    if (onToggle && (selecting || event.shiftKey)) {
      onToggle(photo, { range: event.shiftKey });
      return;
    }
    if (!open) return;
    // Focus before opening: the viewer restores focus to
    // document.activeElement on close, and macOS Safari does not focus
    // a <button> on mouse-down, so the opener would be <body>.
    event.currentTarget.focus();
    onOpen?.(photo);
  };

  const tick = onToggle && (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`Select ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(photo, { range: event.shiftKey });
      }}
      // 44px target around a 24px tick. At desktop it appears on hover or
      // keyboard focus; on a phone only once selecting has begun, so a stray
      // tap on a corner never starts a selection.
      className={cn(
        "absolute left-0 top-0 z-[1] flex h-11 w-11 items-start justify-start p-1.5 focus:outline-none focus-visible:opacity-100 [&:focus-visible>span]:ring-2 [&:focus-visible>span]:ring-white",
        selected || selecting
          ? "opacity-100"
          : isDesktop
            ? "opacity-0 group-hover:opacity-100"
            : "pointer-events-none opacity-0"
      )}
    >
      <Tick checked={selected} />
    </button>
  );

  // Selected: a blue edge drawn *inside* the tile, uncovered once the photo
  // shrinks to scale-90. A ring outside the tile was clipped by the
  // scrollport's sides and hidden under a stuck group header.
  const frame = cn(
    "group relative aspect-square select-none overflow-hidden rounded-md bg-[#2e2e2e] [-webkit-touch-callout:none]",
    selected && "shadow-[inset_0_0_0_2px_#2680FC]"
  );

  if (isOpenable(photo) && photo.thumb_path) {
    const meta = isDesktop
      ? [formatCaptureDay(photo.captured_at), photo.uploader?.full_name]
          .filter(Boolean)
          .join(" · ")
      : "";
    return (
      <div className={frame} {...pressHandlers}>
        <button
          type="button"
          onClick={(event) => handleClick(event, true)}
          aria-pressed={onToggle && selecting ? selected : undefined}
          className="block h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2680FC]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={publicUrl(photo.thumb_path)}
            alt={photoName(photo) ?? ""}
            loading="lazy"
            draggable={false}
            className={cn(
              "h-full w-full object-cover transition-transform",
              selected && "scale-90 rounded-sm"
            )}
          />
          {/* TODO(#14): prefers-reduced-motion is unhandled app-wide (this transition, the rail skeleton pulse, dialog animations); wants one pass across both apps rather than here alone. */}
          {meta && !selecting && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 break-words bg-[#222222] px-2 py-1.5 text-left text-sm text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {meta}
            </span>
          )}
          {photo.kind === "video" && (
            <span className={cn(tilePillClass, "bottom-1 right-1 flex items-center gap-0.5")}>
              <Play className="h-2.5 w-2.5 fill-current" />
              {photo.duration_secs != null
                ? formatDuration(photo.duration_secs)
                : "Video"}
            </span>
          )}
          {favorite && <FavoriteBadge />}
        </button>
        {tick}
      </div>
    );
  }

  const size = formatBytes(photo.original_bytes);
  // "Other" says nothing the file name does not.
  const type = fileTypeLabel(photo);
  return (
    <div
      // Selected, the 1px border turns blue and the inset adds 1px: the same 2px edge.
      className={cn(
        frame,
        "border",
        selected ? "border-[#2680FC] shadow-[inset_0_0_0_1px_#2680FC]" : "border-[#4e4e4e]"
      )}
      {...pressHandlers}
      onClick={(event) => handleClick(event, false)}
    >
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center transition-transform",
          selected && "scale-90"
        )}
      >
        {photo.kind === "video" ? (
          <Video className="h-5 w-5 text-[#a0a0a0]" />
        ) : (
          <FileText className="h-5 w-5 text-[#a0a0a0]" />
        )}
        <span className="line-clamp-2 w-full break-all text-[11px] text-[#b4b4b4]">{name}</span>
        {size && <span className="text-[11px] text-[#8e8e8e]">{size}</span>}
      </div>
      {/* In a corner so the name line keeps clear of the download link on a phone tile. */}
      {type !== "Other" && <span className={cn(tilePillClass, "right-1 top-1")}>{type}</span>}
      {favorite && <FavoriteBadge />}
      {!selecting && (
        <a
          href={downloadUrl(photo)}
          aria-label={`Download ${photoName(photo) ?? "original"}`}
          onClick={(event) => event.stopPropagation()}
          className="absolute bottom-1 right-1 flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[#222222] p-1.5 text-white hover:bg-[#2680FC]"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
      {tick}
    </div>
  );
});

/*
 * The desktop track is minmax(140px, 1fr), not a capped max: auto-fill counts
 * repetitions off the *definite* track size, so a capped max under-counts the
 * columns. The 140px min pairs with the rail narrowing to 220px below 1280.
 */
function TileGrid({
  photos,
  onOpen,
  isDesktop,
  onToggle,
  selectedIds,
  me,
}: {
  photos: PhotoRow[];
  onOpen?: OnOpen;
  isDesktop: boolean;
  onToggle?: OnToggle;
  selectedIds?: ReadonlySet<string>;
  /** The reader's user id, for the favorite hearts. */
  me: string | undefined;
}) {
  const selecting = (selectedIds?.size ?? 0) > 0;
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 desktop:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] desktop:gap-2">
      {photos.map((photo) => (
        <Tile
          key={photo.id}
          photo={photo}
          onOpen={onOpen}
          isDesktop={isDesktop}
          onToggle={onToggle}
          selected={selectedIds?.has(photo.id) ?? false}
          selecting={selecting}
          favorite={isFavorite(photo, me)}
        />
      ))}
    </div>
  );
}

/**
 * Memoized: the page re-renders on things the grid does not draw (a viewer
 * swipe, the infinite query's fetch status), and those skip the grid entirely.
 * The page passes memoized `groups` and stable callbacks so this holds.
 */
const PhotoGrid = memo(function PhotoGrid({
  groups,
  groupBy = "date",
  onOpenPhoto,
  selection,
  pinnedTag,
  pinnedLabel,
  onExpandPinned,
}: PhotoGridProps) {
  const isDesktop = useDesktop();
  // One actor lookup for the whole grid, not one per group.
  const me = usePhotoActor()?.user_id;
  const selectedIds = selection?.selectedIds;
  const selecting = (selectedIds?.size ?? 0) > 0;
  // The selection object is rebuilt whenever the set changes; tiles get one
  // stable toggle that calls the latest one, so ticking a photo re-renders
  // only that tile (and every tile once when selecting starts or stops).
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const toggle = useCallback<OnToggle>(
    (photo, options) => selectionRef.current?.onToggle(photo, options),
    []
  );
  const onToggle = selection ? toggle : undefined;
  const tileLayout = isDesktop ? DESKTOP_TILES : PHONE_TILES;
  const pinned = useMemo(
    () =>
      pinnedTag && groupBy === "date"
        ? groups
            .flatMap((group) => group.photos)
            .filter((photo) => photo.tags.includes(pinnedTag))
        : [],
    [groups, groupBy, pinnedTag]
  );

  return (
    <div>
      {/* The pinned row stays put while selecting and selects like any other
          tile (selection is by photo id, so both copies show the tick). Hiding
          it would slide the whole grid up under a finger that is mid-press. */}
      {pinned.length > 0 && (
        <section>
          <button
            type="button"
            onClick={onExpandPinned}
            className="mb-1 mt-2 flex min-h-11 items-center text-sm font-semibold text-[#8bbaff] hover:text-white"
          >
            {pinnedLabel ?? pinnedTag} · {pinned.length} ›
          </button>
          {/* TODO(#15): design-standard drift — this pinned-row slice(0, 3), the lightbox close icon size, and the TopBar search max-width are separate cosmetic calls to settle together. */}
          <TileGrid
            photos={pinned.slice(0, 3)}
            onOpen={onOpenPhoto}
            isDesktop={isDesktop}
            onToggle={onToggle}
            selectedIds={selectedIds}
            me={me}
          />
        </section>
      )}
      {groups.map((group) => {
        const allSelected =
          group.photos.length > 0 &&
          group.photos.every((photo) => selectedIds?.has(photo.id));
        return (
          <section
            key={group.key}
            // Off-screen sections skip layout and paint (see grid-layout.ts).
            // The sticky header lives inside its own section, so it still
            // sticks while its section is on screen. This also clips paint to
            // the section; the clip margin keeps the header tick's focus ring,
            // pulled 10px left by its negative margin, from being cut off.
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${sectionHeightGuess(group.photos.length, tileLayout)}px`,
              overflowClipMargin: "4px",
            }}
          >
            {/* A stuck header must sit flush with the scrollport edge, with its
                own tiles never scrolling through an unpainted band above it. */}
            <div className="group/header mt-1 flex min-h-11 items-center desktop:sticky desktop:top-0 desktop:z-10 desktop:mt-0 desktop:bg-[#222222]/95 desktop:backdrop-blur">
              {selection && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allSelected}
                  aria-label={`Select all of ${group.label}`}
                  onClick={() => selection.onToggleGroup(group)}
                  // Same rule as the tile tick: hover or focus at desktop, and
                  // on a phone only once selecting has begun.
                  // The negative margin lines the tick up with the tiles' edge;
                  // it only applies while the tick takes up room, so a hidden
                  // tick never drags the date to the left of the grid.
                  className={cn(
                    "flex h-11 shrink-0 items-center justify-center focus:outline-none [&:focus-visible>span]:ring-2 [&:focus-visible>span]:ring-white",
                    selecting
                      ? "-ml-2.5 w-11"
                      : isDesktop
                        ? "w-0 overflow-hidden opacity-0 focus-visible:-ml-2.5 focus-visible:w-11 focus-visible:opacity-100 group-hover/header:-ml-2.5 group-hover/header:w-11 group-hover/header:opacity-100"
                        : "hidden"
                  )}
                >
                  <Tick checked={allSelected} className="shadow-none" />
                </button>
              )}
              <h2 className="min-w-0 break-words text-sm text-[#b4b4b4]">
                {group.label}
                {groupBy !== "date" && (
                  <span className="text-[#8e8e8e]">
                    {" "}
                    · {plural(group.photos.length, "photo")}
                  </span>
                )}
              </h2>
            </div>
            <TileGrid
              photos={group.photos}
              onOpen={onOpenPhoto}
              isDesktop={isDesktop}
              onToggle={onToggle}
              selectedIds={selectedIds}
              me={me}
            />
          </section>
        );
      })}
    </div>
  );
});

export default PhotoGrid;
