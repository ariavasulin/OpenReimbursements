"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useDesktop } from "@/hooks/use-desktop";
import { useLongPress } from "@/hooks/use-long-press";
import { Tick } from "@/components/photos/photo-grid";
import { prefetchCollection, type CollectionTarget } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";
import { publicUrl } from "@/lib/photos/urls";
import { cn } from "@/lib/utils";

/** One card's part in selecting, from useCollectionSelect. */
export interface CardSelection {
  /** Marks the tick, so focus can come back to it when the bar closes. */
  id: string;
  selected: boolean;
  /** Anything on the list is selected: every card shows its tick, and a click toggles. */
  selecting: boolean;
  /** `range`: shift was held, so select from the last tick to this card. */
  onToggle(options: { range: boolean }): void;
}

/** A mouse resting this long on a card is heading for it; one sweeping past is not. */
const HOVER_INTENT_MS = 80;

/**
 * Starts loading what a card opens as soon as someone shows they mean to open
 * it: a mouse resting on it, keyboard focus, or a finger touching down (about
 * 100 ms before the tap ends). Never just because the card is on screen.
 */
function usePrefetchOnIntent(target: CollectionTarget | undefined) {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  if (!target) return {};
  const now = () => {
    cancel();
    prefetchCollection(queryClient, target);
  };
  return {
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      cancel();
      timer.current = setTimeout(now, HOVER_INTENT_MS);
    },
    onPointerLeave: cancel,
    onFocus: now,
    onTouchStart: now,
  };
}

/**
 * One album or project in a list: its name (up to two lines, never cut to a
 * few words), a labeled count line, and its four newest thumbnails.
 *
 * Selects like a photo tile: a tick in the corner on hover (desktop) or a
 * press and hold (phone) starts selecting; while selecting, a click or tap
 * anywhere on a card toggles it, and shift-click takes a range.
 */
export default function CollectionCard({
  href,
  name,
  detail,
  photoCount,
  thumbPaths,
  emptyText,
  selection,
  prefetch,
}: {
  href: string;
  name: string;
  /** Goes before the count, e.g. "Project #3612". */
  detail?: string;
  photoCount: number;
  /** Server caps at 4. */
  thumbPaths: string[];
  emptyText: string;
  selection?: CardSelection;
  /** What opening the card shows, loaded on hover, focus, or touch. */
  prefetch?: CollectionTarget;
}) {
  const isDesktop = useDesktop();
  const intent = usePrefetchOnIntent(prefetch);
  const { handlers: pressHandlers, takeHold } = useLongPress(
    selection && !isDesktop ? () => selection.onToggle({ range: false }) : null
  );
  const selected = selection?.selected ?? false;
  const selecting = selection?.selecting ?? false;
  const remainder = photoCount - thumbPaths.length;

  const body: ReactNode = (
    <>
      {/* The right padding keeps a long name clear of the tick. */}
      <div className="line-clamp-2 break-words pr-7 text-base font-semibold leading-snug text-white">
        {name}
      </div>
      <div className="mb-2.5 mt-0.5 text-sm text-[#b4b4b4]">
        {detail ? `${detail} · ` : ""}
        {plural(photoCount, "photo")}
      </div>
      {thumbPaths.length > 0 ? (
        <div className="grid grid-cols-4 gap-1.5">
          {thumbPaths.map((path, index) => (
            <div
              key={path}
              className="relative aspect-square overflow-hidden rounded-md bg-[#3e3e3e]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(path)}
                alt=""
                loading="lazy"
                draggable={false}
                className="h-full w-full object-cover"
              />
              {index === thumbPaths.length - 1 && remainder > 0 && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-sm font-semibold text-white">
                  +{remainder}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex aspect-[4/1] items-center justify-center rounded-md border border-dashed border-[#4e4e4e] text-sm text-[#a0a0a0]">
          {emptyText}
        </div>
      )}
    </>
  );

  // An inset ring beside the border makes a 2 px edge that no neighbour clips.
  const cardClass = cn(
    "block h-full w-full rounded-xl border bg-[#2a2a2a] p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]",
    selected
      ? "border-[#2680FC] ring-1 ring-inset ring-[#2680FC]"
      : selecting
        ? "border-[#3e3e3e] hover:border-[#8e8e8e]"
        : "border-[#3e3e3e] hover:border-[#2680FC]"
  );

  return (
    <div
      className="group relative select-none [-webkit-touch-callout:none]"
      {...pressHandlers}
      // The click that ends a press and hold must not also open or toggle the card.
      onClickCapture={(event) => {
        if (takeHold()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {selection && selecting ? (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={name}
          onClick={(event) => selection.onToggle({ range: event.shiftKey })}
          className={cardClass}
        >
          {body}
        </button>
      ) : (
        <Link
          href={href}
          title={name}
          {...intent}
          onClick={(event) => {
            // As on a photo tile, shift-click selects rather than opening.
            if (!selection || !event.shiftKey) return;
            event.preventDefault();
            selection.onToggle({ range: true });
          }}
          className={cardClass}
        >
          {body}
        </Link>
      )}
      {selection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${name}`}
          data-select-id={selection.id}
          onClick={(event) => selection.onToggle({ range: event.shiftKey })}
          // The photo tile's tick: a 44px target around a 24px tick, shown on
          // hover or keyboard focus at desktop, and on a phone only once
          // selecting has begun, so a stray tap on a corner never starts one.
          className={cn(
            "absolute right-0 top-0 z-[1] flex h-11 w-11 items-start justify-end p-2.5 focus:outline-none focus-visible:opacity-100 [&:focus-visible>span]:ring-2 [&:focus-visible>span]:ring-white",
            selected || selecting
              ? "opacity-100"
              : isDesktop
                ? "opacity-0 group-hover:opacity-100"
                : "pointer-events-none opacity-0"
          )}
        >
          <Tick checked={selected} />
        </button>
      )}
    </div>
  );
}
