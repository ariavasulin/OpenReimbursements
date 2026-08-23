"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import Lightbox, {
  type GenericSlide,
  type Slide,
} from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Inline from "yet-another-react-lightbox/plugins/inline";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import { supabase } from "@/lib/supabaseClient";
import { useDesktop } from "@/hooks/use-desktop";
import { downloadUrl, previewUrl, publicUrl } from "@/lib/photos/urls";
import EditPhotoSheet from "@/components/photos/edit-photo-sheet";
import PhotoInfo from "@/components/photos/photo-info";
import {
  PHOTOS_SCROLLPORT_ID,
  usePhotosShell,
} from "@/components/photos/photos-shell-context";
import { TOAST_REGION_ID } from "@/lib/toast-region";
import type { PhotoRow } from "@/lib/photos/types";
import { videoSource } from "@/lib/photos/video-source";

// Zoom/swipe run on the screen-quality preview, never the original —
// "Download original" streams the untouched file. Editing opens
// EditPhotoSheet on top of the viewer; both viewer paths sit at z-40 so the
// sheet (z-50) and its nested pickers (z-[60]) stack above them.
//
// - Phone: YARL's overlay mode with the info bar in render.controls.
// - Desktop: YARL's Inline plugin inside our own fixed fullscreen row, with
//   PhotoInfo as a *sibling* 320px panel. Sibling, never render.controls:
//   inside YARL's container its keydown handling would turn arrow keys into
//   slide changes while the user types in a field. The Inline plugin
//   does `replace(MODULE_PORTAL, …)`, and Portal is where YARL's overlay
//   duties lived, so on the desktop path this file owns all of them.

// Custom slide for videos this browser reports it can't decode: the poster
// with a download card instead of a dead play button (rendered by
// `render.slide` below).
declare module "yet-another-react-lightbox" {
  interface SlideTypes {
    unplayable: SlideUnplayable;
  }
  interface SlideUnplayable extends GenericSlide {
    type: "unplayable";
    /** Poster/preview image behind the card; "" when none exists. */
    poster: string;
    /** Content-Disposition download URL for the original. */
    download: string;
    name: string;
  }
}

/**
 * `canPlayType` probe; SSR has no `document`, so report "can't play". The
 * answer depends only on the MIME string, so cache it — the slides memo
 * re-probes every video row each time `photos` grows by a page.
 */
const canPlayCache = new Map<string, string>();
const canPlay = (type: string): string => {
  const cached = canPlayCache.get(type);
  if (cached !== undefined) return cached;
  const answer =
    typeof document === "undefined"
      ? ""
      : document.createElement("video").canPlayType(type);
  canPlayCache.set(type, answer);
  return answer;
};

/**
 * Set an attribute the element does not already carry, returning the undo
 * that removes it again. Never restores a previous value: another writer
 * (Radix's `hideOthers`) may clear its own `aria-hidden` while the viewer is
 * up, and putting the stale value back would hide the app for the session.
 */
function addAttribute(
  element: Element,
  attribute: string,
  value: string
): () => void {
  if (element.hasAttribute(attribute)) return () => {};
  element.setAttribute(attribute, value);
  return () => element.removeAttribute(attribute);
}

/**
 * A body child the sweep must leave alone: something another modal already
 * hid (Radix marks those `data-aria-hidden`), or the live layer of that modal
 * itself — a sheet open before the viewer stays usable above it.
 */
function ownedByAnotherLayer(element: Element): boolean {
  return (
    element.hasAttribute("data-aria-hidden") ||
    element.querySelector('[role="dialog"][data-state="open"]') !== null
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(
    (element) =>
      element.dataset.focusSentinel === undefined &&
      !element.hasAttribute("disabled") &&
      element.tabIndex >= 0 &&
      (element.offsetWidth > 0 ||
        element.offsetHeight > 0 ||
        element.getClientRects().length > 0)
  );
}

function unplayableSlide(slide: {
  poster: string;
  download: string;
  name: string;
}) {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {slide.poster && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={slide.poster}
          alt={slide.name}
          className="max-h-full max-w-full object-contain opacity-40"
        />
      )}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="pointer-events-auto mx-4 rounded-xl border border-[#4e4e4e] bg-[#2e2e2e]/95 px-6 py-5 text-center">
          <p className="text-sm text-white">
            Can&apos;t play this video in this browser
          </p>
          <a
            href={slide.download}
            className="mt-3 inline-block rounded-lg bg-[#2680FC] px-6 py-2 text-xs font-medium text-white hover:bg-[#1a6fd8]"
          >
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

interface PhotoLightboxProps {
  /** Openable photos in display order (the current filtered/grouped set). */
  photos: PhotoRow[];
  open: boolean;
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
  /** Fired after a successful edit or delete so grids refetch. */
  onChanged(): void;
}

export default function PhotoLightbox({
  photos,
  open,
  index,
  onIndexChange,
  onClose,
  onChanged,
}: PhotoLightboxProps) {
  const isDesktop = useDesktop();
  const { setViewerOpen } = usePhotosShell();
  const [editing, setEditing] = useState(false);

  // The shell's drop intake treats an open desktop viewer as busy: a drop
  // would otherwise open the upload sheet over a layer still asserting
  // aria-modal, with one Escape then closing both.
  useEffect(() => {
    if (!(open && isDesktop)) return;
    setViewerOpen(true);
    return () => setViewerOpen(false);
  }, [open, isDesktop, setViewerOpen]);

  const photo = photos[index] as PhotoRow | undefined;

  const slides = useMemo(
    () =>
      photos.map((item): Slide => {
        if (item.kind !== "video") {
          return {
            src: previewUrl(item) ?? "",
            alt: item.original_name ?? "",
          };
        }
        // Playback streams from storage (which serves range requests)
        // behind the generated poster frame.
        const source = videoSource(item, publicUrl, canPlay);
        if ("unplayable" in source) {
          return {
            type: "unplayable",
            poster: previewUrl(item) ?? "",
            download: downloadUrl(item),
            name: item.original_name ?? "video",
          };
        }
        return {
          type: "video",
          poster: previewUrl(item) ?? undefined,
          controls: true,
          playsInline: true,
          preload: "none",
          sources: [source],
        };
      }),
    [photos]
  );

  // Who am I? Delete is uploader-or-admin; hide the button otherwise (RLS
  // still enforces it server-side either way).
  const { data: me } = useQuery({
    queryKey: ["own-profile"],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return null;
      const { data } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", session.user.id)
        .single();
      return { id: session.user.id, role: data?.role ?? "employee" };
    },
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const canDelete =
    !!photo && !!me && (photo.uploader_id === me.id || me.role === "admin");

  // Leaving a slide abandons any half-done edit on it.
  useEffect(() => {
    setEditing(false);
  }, [index, open]);

  // The fixed fullscreen row (portalled to <body>) and the info panel.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Esc closes. Capture phase: YARL's container keydown stopPropagation()s
  // Escape (its own close action is a no-op under the Inline plugin), so a
  // bubble-phase window listener would never hear it. Capture also means no
  // inner control can pre-empt it, so the panel is carved out by hand, and so
  // is the edit sheet: while it is up Escape belongs to the sheet.
  useEffect(() => {
    if (!(open && isDesktop) || editing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const { target } = event;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, isDesktop, editing, onClose]);

  // Everything outside the viewer goes inert + aria-hidden while it is up —
  // the loop YARL's Portal ran over its own siblings — and closing hands focus
  // back to whatever opened the viewer, normally the grid tile. One effect
  // because the order matters at both ends: the opener has to be read before
  // inert blurs it, and un-inerted before it can take focus again.
  //
  // Only body children present when the viewer opens are swept; anything
  // portalled to <body> afterwards is not, which is what keeps the edit sheet
  // usable above the viewer.
  useEffect(() => {
    if (!(open && isDesktop)) return;
    const opener = document.activeElement;
    const node = wrapperRef.current;
    const siblings = document.body.children;
    const undo: (() => void)[] = [];
    for (let i = 0; i < siblings.length; i += 1) {
      const element = siblings[i];
      if (element === node) continue;
      if (["TEMPLATE", "SCRIPT", "STYLE"].includes(element.tagName)) continue;
      // The viewer fires its own toasts; inerting this region would have it
      // silence its own feedback. Toasts render above the viewer, not behind
      // it.
      if (element.id === TOAST_REGION_ID) continue;
      if (ownedByAnotherLayer(element)) continue;
      undo.push(addAttribute(element, "inert", ""));
      undo.push(addAttribute(element, "aria-hidden", "true"));
    }
    return () => {
      undo.forEach((restore) => restore());
      // The opener can be gone by now (deleted, or reassigned out of the
      // filtered set); focusing a detached node is a silent no-op that dumps
      // a keyboard user at the top of the document. Land on the scrollport.
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      } else {
        document.getElementById(PHOTOS_SCROLLPORT_ID)?.focus();
      }
    };
  }, [open, isDesktop]);

  // Scroll-lock while open. The body is already overflow-hidden app-wide, so
  // only the photos scrollport needs it — it is the real scroller behind the
  // viewer, and the pointer sits over it while the viewer is up, so wheel
  // events would chain into it.
  useEffect(() => {
    if (!(open && isDesktop)) return;
    const scrollport = document.getElementById(PHOTOS_SCROLLPORT_ID);
    if (!scrollport) return;
    const previousPort = scrollport.style.overflow;
    scrollport.style.overflow = "hidden";
    return () => {
      scrollport.style.overflow = previousPort;
    };
  }, [open, isDesktop]);

  // Focus the carousel on open so arrow keys navigate immediately. YARL's
  // own focus-on-mount only fires inside its portal (overlay mode).
  const carouselCellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!(open && isDesktop)) return;
    const frame = requestAnimationFrame(() => {
      carouselCellRef.current
        ?.querySelector<HTMLElement>(".yarl__container")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, isDesktop]);

  // Click-away on the backdrop (the empty slide area around the image).
  // YARL's own closeOnBackdropClick dispatches its close action, which the
  // Inline plugin no-ops — so we replicate its guard: pointer up on the same
  // backdrop element it went down on, with no drag in between.
  const backdropPointer = useRef<{
    target: EventTarget;
    x: number;
    y: number;
  } | null>(null);
  const handleBackdropPointerDown = (event: React.PointerEvent) => {
    backdropPointer.current = {
      target: event.target,
      x: event.clientX,
      y: event.clientY,
    };
  };
  const handleBackdropPointerUp = (event: React.PointerEvent) => {
    const down = backdropPointer.current;
    backdropPointer.current = null;
    if (!down || down.target !== event.target) return;
    if (
      Math.abs(event.clientX - down.x) > 5 ||
      Math.abs(event.clientY - down.y) > 5
    ) {
      return;
    }
    const { target } = event;
    if (
      target instanceof HTMLElement &&
      (target.classList.contains("yarl__slide") ||
        target.classList.contains("yarl__slide_wrapper"))
    ) {
      onClose();
    }
  };

  const handleDeleted = () => {
    onChanged();
    onClose();
  };

  // Tab containment. Sentinels rather than a keydown trap: they don't need to
  // know where the focusable elements sit inside YARL's own DOM.
  const wrapFocus = (edge: "first" | "last") => () => {
    const node = wrapperRef.current;
    if (!node) return;
    const tabbable = tabbableWithin(node);
    const target =
      tabbable.length > 0
        ? tabbable[edge === "first" ? 0 : tabbable.length - 1]
        : node.querySelector<HTMLElement>(".yarl__container");
    target?.focus();
  };

  const sentinel = (edge: "first" | "last") => (
    <div
      data-focus-sentinel=""
      tabIndex={0}
      aria-hidden="true"
      onFocus={wrapFocus(edge)}
    />
  );

  const editSheet = (
    <EditPhotoSheet
      photo={photo ?? null}
      open={editing}
      onOpenChange={setEditing}
      onSaved={onChanged}
    />
  );

  // Shared by both paths; each adds its own plugins, styles and render slots.
  const common = {
    index,
    on: {
      view: ({ index: viewIndex }: { index: number }) => onIndexChange(viewIndex),
    },
    slides,
    zoom: { maxZoomPixelRatio: 4, doubleTapDelay: 300 },
    carousel: { finite: false },
    styles: { container: { backgroundColor: "rgba(0,0,0,.92)" } },
    render: {
      // Returning undefined falls through to the default slide renderers
      // (image, and the Video plugin's player).
      slide: ({ slide }: { slide: Slide }) =>
        slide.type === "unplayable" ? unplayableSlide(slide) : undefined,
    },
  };

  if (isDesktop) {
    if (!open) return null;
    // Portalled to <body> so the inert loop above can reach the whole app:
    // rendered in place, the viewer's own ancestors would have to be hidden.
    return (
      <>
        {createPortal(
          <div
            ref={wrapperRef}
            role="dialog"
            aria-modal="true"
            aria-label="Photo viewer"
            className="fixed inset-0 z-40 flex bg-black/95"
          >
            {sentinel("last")}
            <div
              ref={carouselCellRef}
              className="relative min-w-0 flex-1"
              onPointerDown={handleBackdropPointerDown}
              onPointerUp={handleBackdropPointerUp}
            >
              <Lightbox
                {...common}
                plugins={[Inline, Zoom, Video, Counter, Thumbnails]}
                inline={{ style: { width: "100%", height: "100%" } }}
                // Inline mode removes YARL's close action, and with it the only
                // visible way out of the viewer. Put a real button back in the
                // toolbar slot — Esc and click-away are not discoverable.
                toolbar={{
                  buttons: [
                    <button
                      key="close"
                      type="button"
                      aria-label="Close"
                      onClick={onClose}
                      className="yarl__button"
                    >
                      <X className="h-6 w-6" />
                    </button>,
                  ],
                }}
                styles={{
                  ...common.styles,
                  // The container is no longer the full viewport; keep the
                  // toolbar and next-arrow pinned inside it, not under the panel.
                  toolbar: { right: 0 },
                  navigationNext: { right: 0 },
                }}
              />
            </div>
            {photo && (
              <aside
                ref={panelRef}
                // The window capture listener skips the panel, so Escape that no
                // inner layer claimed still closes the viewer from in here.
                onKeyDown={(event) => {
                  if (event.key === "Escape") onClose();
                }}
                className="w-[320px] shrink-0 overflow-y-auto border-l border-[#4e4e4e] bg-[#2e2e2e]"
              >
                <PhotoInfo
                  photo={photo}
                  layout="panel"
                  canDelete={canDelete}
                  onEdit={() => setEditing(true)}
                  onDeleted={handleDeleted}
                />
              </aside>
            )}
            {sentinel("first")}
          </div>,
          document.body
        )}
        {editSheet}
      </>
    );
  }

  return (
    <>
      <Lightbox
        {...common}
        open={open}
        close={onClose}
        plugins={[Zoom, Video, Counter]}
        controller={{ closeOnBackdropClick: false }}
        styles={{ ...common.styles, root: { zIndex: 40 } }}
        render={{
          ...common.render,
          controls: () => (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
              {photo && (
                <PhotoInfo
                  photo={photo}
                  layout="bar"
                  canDelete={canDelete}
                  onEdit={() => setEditing(true)}
                  onDeleted={handleDeleted}
                />
              )}
            </div>
          ),
        }}
      />
      {editSheet}
    </>
  );
}
