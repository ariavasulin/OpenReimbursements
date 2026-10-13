"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Pause, Play, X } from "lucide-react";
import Lightbox, {
  type GenericSlide,
  type Slide,
  type SlideshowRef,
} from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Video from "yet-another-react-lightbox/plugins/video";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Inline from "yet-another-react-lightbox/plugins/inline";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Slideshow from "yet-another-react-lightbox/plugins/slideshow";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import { useDesktop } from "@/hooks/use-desktop";
import { downloadUrl, previewUrl, publicUrl } from "@/lib/photos/urls";
import { photoName } from "@/lib/photos/format";
import EditPhotoSheet from "@/components/photos/edit-photo-sheet";
import PhotoInfo from "@/components/photos/photo-info";
import SetProjectSheet from "@/components/photos/set-project-sheet";
import SheetShell from "@/components/photos/sheet-shell";
import {
  PHOTOS_SCROLLPORT_ID,
  usePhotosShell,
} from "@/components/photos/photos-shell-context";
import { useRegisterSlideshow } from "@/components/photos/slideshow-link";
import { TOAST_REGION_ID } from "@/lib/toast-region";
import type { PhotoRow } from "@/lib/photos/types";
import { videoSource } from "@/lib/photos/video-source";

// Zoom/swipe run on the screen-quality preview, never the original —
// "Download" streams the untouched original. "Edit tags" and "Set
// project" open pop-ups on top of the viewer; both viewer paths sit at z-40 so
// a pop-up (z-50) and its nested pickers (z-[60]) stack above them.
//
// - Phone: YARL's overlay mode. The photo is unobscured; a labeled "Details"
//   button in the toolbar opens an opaque pop-up with the facts and actions.
//   (They used to sit on a gradient over the photo, unreadable on bright ones.)
// - Desktop: YARL's Inline plugin inside our own fixed fullscreen row, with
//   PhotoInfo as a *sibling* 340px panel, shown when the "i" (Details) toggle
//   is on — off by default, remembered for the browser tab. Sibling, never
//   render.controls: inside YARL's container its keydown handling would turn
//   arrow keys into slide changes while the user types in a field. The Inline
//   plugin does `replace(MODULE_PORTAL, …)`, and Portal is where YARL's overlay
//   duties lived, so on the desktop path this file owns all of them.
//
// Both paths: photos fill the screen (no carousel padding), and a tap on the
// photo or the black around it hides every control — toolbar, counter,
// arrows, thumbnails, the Details panel — and the next tap brings them back
// (`yarl__immersive`, styled in globals.css). On desktop a click on the black
// around the photo still closes the viewer while the controls are showing.
//
// Play runs a slideshow (4 s a photo, looping) of the photos only: while it
// plays, the viewer's slides are the stills, never a video. It starts with
// the controls hidden, and any tap pauses it and shows them. A page's header
// Play button reaches it through <SlideshowLink>.

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
      // Controls hidden by a tap keep their size but cannot take focus.
      getComputedStyle(element).visibility !== "hidden" &&
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
    <div data-tap="photo" className="relative flex h-full w-full items-center justify-center">
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

/** sessionStorage key for the desktop Details toggle: on or off for the tab. */
const DETAILS_KEY = "dws-photos:viewer-details";

function readDetailsPreference(): boolean {
  try {
    return window.sessionStorage.getItem(DETAILS_KEY) === "on";
  } catch {
    return false; // storage blocked: default off, as on a first visit
  }
}

function writeDetailsPreference(on: boolean): void {
  try {
    window.sessionStorage.setItem(DETAILS_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the toggle still works, it just is not remembered.
  }
}

/** What a tap landed on: the photo, the black around it, or neither. */
function tapArea(target: EventTarget): "photo" | "backdrop" | null {
  if (!(target instanceof Element)) return null;
  if (target.classList.contains("yarl__slide_image") || target.getAttribute("data-tap") === "photo") {
    return "photo";
  }
  if (
    target.classList.contains("yarl__slide") ||
    target.classList.contains("yarl__slide_wrapper")
  ) {
    return "backdrop";
  }
  return null;
}

/** A toolbar button styled like YARL's own (its hover, focus, and size). */
const toolbarButtonClass = "yarl__button";

interface PhotoLightboxProps {
  /** Openable photos in display order (the current filtered/grouped set). */
  photos: PhotoRow[];
  open: boolean;
  index: number;
  onIndexChange(index: number): void;
  /** The viewer is a few photos from the end of `photos`: load more if there are more. */
  onNearEnd?(): void;
  onClose(): void;
  /** Fired after a successful edit or delete so grids refetch. */
  onChanged(): void;
}

export default function PhotoLightbox({
  photos,
  open,
  index,
  onIndexChange,
  onNearEnd,
  onClose,
  onChanged,
}: PhotoLightboxProps) {
  const isDesktop = useDesktop();
  const { setViewerOpen } = usePhotosShell();
  const [editing, setEditing] = useState(false);
  const [settingProject, setSettingProject] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Desktop Details panel. Read from the tab's storage after mount (SSR has
  // no window); the viewer is never open on first paint anyway.
  const [desktopDetails, setDesktopDetails] = useState(false);
  useEffect(() => setDesktopDetails(readDetailsPreference()), []);
  const toggleDesktopDetails = () => {
    setDesktopDetails((previous) => {
      writeDetailsPreference(!previous);
      return !previous;
    });
  };
  // A tap hides every control; the next one brings them back.
  const [chromeHidden, setChromeHidden] = useState(false);
  // YARL's Fullscreen plugin fullscreens its own container; the Details panel
  // sits outside it, so the toggle is hidden while fullscreen is on.
  const [fullscreen, setFullscreen] = useState(false);
  // True from Play until the slideshow stops: the slides are the stills only.
  const [slideshowActive, setSlideshowActive] = useState(false);
  const slideshowRef = useRef<SlideshowRef>(null);

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
            alt: photoName(item) ?? "",
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
            name: photoName(item) ?? "video",
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

  // The slideshow's set: the same photos in the same order, minus videos
  // (playable or not). `stillIndex` maps a photo's position in `photos` to its
  // position among the stills; -1 for a video.
  const { stillSlides, stillPhotos, stillIndex } = useMemo(() => {
    const stillSlides: Slide[] = [];
    const stillPhotos: number[] = [];
    const stillIndex = photos.map((item, at) => {
      if (item.kind === "video") return -1;
      stillSlides.push(slides[at]);
      stillPhotos.push(at);
      return stillSlides.length - 1;
    });
    return { stillSlides, stillPhotos, stillIndex };
  }, [photos, slides]);
  const hasStills = stillPhotos.length > 0;

  /** The first still at or after `from` in `photos`, wrapping; -1 if none. */
  const nextStill = useCallback(
    (from: number) => {
      for (let step = 0; step < photos.length; step += 1) {
        const at = (from + step) % photos.length;
        if (stillIndex[at] !== -1) return at;
      }
      return -1;
    },
    [photos.length, stillIndex]
  );

  // While playing, YARL sees the stills; everywhere else, every photo.
  const viewSlides = slideshowActive ? stillSlides : slides;
  const viewIndex = slideshowActive ? Math.max(0, stillIndex[index] ?? 0) : index;

  // Leaving a slide abandons any half-done edit on it.
  useEffect(() => {
    setEditing(false);
    setSettingProject(false);
  }, [index, open]);
  useEffect(() => {
    if (open) return;
    setDetailsOpen(false);
    setChromeHidden(false);
    setSlideshowActive(false);
    setFullscreen(false);
  }, [open]);

  // The slideshow (and the arrow keys) can run past the loaded pages: ask the
  // grid for the next one a few photos before the end.
  useEffect(() => {
    if (open && onNearEnd && index >= photos.length - 5) onNearEnd();
  }, [open, index, photos.length, onNearEnd]);

  /** Play from the viewer's toolbar: from this photo, or the next still. */
  const playFromHere = () => {
    const from = nextStill(index);
    if (from === -1) return;
    setSlideshowActive(true);
    setChromeHidden(true);
    if (from !== index) onIndexChange(from);
    slideshowRef.current?.play();
  };

  // Play from a page header: open on the first still and play, controls
  // hidden. Opening mounts the slideshow with `autoplay` already true.
  const startFromPageRef = useRef<() => void>(() => {});
  startFromPageRef.current = () => {
    const first = nextStill(0);
    if (first === -1) return;
    setSlideshowActive(true);
    setChromeHidden(true);
    onIndexChange(first);
  };
  const startFromPage = useCallback(() => startFromPageRef.current(), []);
  useRegisterSlideshow(hasStills ? startFromPage : null);

  // The fixed fullscreen row (portalled to <body>) and the info panel.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Esc closes. Capture phase: YARL's container keydown stopPropagation()s
  // Escape (its own close action is a no-op under the Inline plugin), so a
  // bubble-phase window listener would never hear it. Capture also means no
  // inner control can pre-empt it, so the panel is carved out by hand, and so
  // is the edit sheet: while it is up Escape belongs to the sheet.
  useEffect(() => {
    if (!(open && isDesktop) || editing || settingProject) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const { target } = event;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      // With the controls hidden nothing is tabbable, so Space or Enter stands
      // in for the tap: pause the slideshow and bring the controls back.
      if (chromeHidden && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        slideshowRef.current?.pause();
        setChromeHidden(false);
        return;
      }
      if (event.key !== "Escape") return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, isDesktop, editing, settingProject, chromeHidden, onClose]);

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

  // A tap: pointer down and up on the same photo or backdrop element with no
  // drag, pinch, or second finger in between. Capture phase, because Zoom
  // stops pointer events from bubbling while a photo is zoomed in. (YARL's
  // own closeOnBackdropClick dispatches its close action, which the Inline
  // plugin no-ops, so desktop click-away is ours too.)
  const gesture = useRef<{
    target: EventTarget;
    x: number;
    y: number;
    pointers: Set<number>;
    cancelled: boolean;
  } | null>(null);
  const handlePointerDown = (event: React.PointerEvent) => {
    const current = gesture.current;
    if (current) {
      current.pointers.add(event.pointerId);
      if (current.pointers.size > 1) current.cancelled = true;
      return;
    }
    gesture.current = {
      target: event.target,
      x: event.clientX,
      y: event.clientY,
      pointers: new Set([event.pointerId]),
      cancelled: false,
    };
  };
  const handlePointerEnd = (event: React.PointerEvent) => {
    const current = gesture.current;
    if (!current) return;
    current.pointers.delete(event.pointerId);
    if (current.pointers.size > 0) return;
    gesture.current = null;
    if (
      event.type !== "pointerup" ||
      current.cancelled ||
      current.target !== event.target ||
      Math.abs(event.clientX - current.x) > 5 ||
      Math.abs(event.clientY - current.y) > 5
    ) {
      return;
    }
    const area = tapArea(event.target);
    if (!area) return;
    handleTap(area, event.currentTarget as HTMLElement);
  };

  const handleTap = (area: "photo" | "backdrop", root: HTMLElement) => {
    if (slideshowRef.current?.playing) {
      slideshowRef.current.pause();
      setChromeHidden(false);
      return;
    }
    if (isDesktop && area === "backdrop" && !chromeHidden) {
      onClose();
      return;
    }
    if (!chromeHidden) {
      // A focused control is about to vanish; keep arrow keys working.
      const container = root.querySelector<HTMLElement>(".yarl__container");
      if (
        container &&
        document.activeElement instanceof HTMLElement &&
        root.contains(document.activeElement) &&
        document.activeElement !== container
      ) {
        container.focus();
      }
    }
    setChromeHidden(!chromeHidden);
  };

  const tapHandlers = {
    onPointerDownCapture: handlePointerDown,
    onPointerUpCapture: handlePointerEnd,
    onPointerCancelCapture: handlePointerEnd,
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

  // One pop-up at a time on a phone: Details closes as the next one opens.
  const startEdit = () => {
    setDetailsOpen(false);
    setEditing(true);
  };
  const startSetProject = () => {
    setDetailsOpen(false);
    setSettingProject(true);
  };

  const editSheet = (
    <>
      <EditPhotoSheet
        photo={photo ?? null}
        open={editing}
        onOpenChange={setEditing}
        onSaved={onChanged}
      />
      <SetProjectSheet
        photoIds={photo ? [photo.id] : []}
        open={settingProject}
        onOpenChange={setSettingProject}
        onContinue={onClose}
      />
    </>
  );

  // Shared by both paths; each adds its own plugins, styles and render slots.
  const common = {
    index: viewIndex,
    on: {
      view: ({ index: shown }: { index: number }) =>
        onIndexChange(slideshowActive ? (stillPhotos[shown] ?? index) : shown),
      // Stopped by a tap, or by YARL itself: back to every photo, controls up.
      slideshowStop: () => {
        setSlideshowActive(false);
        setChromeHidden(false);
      },
      enterFullscreen: () => setFullscreen(true),
      exitFullscreen: () => setFullscreen(false),
    },
    slides: viewSlides,
    zoom: { maxZoomPixelRatio: 4, doubleTapDelay: 300 },
    // Edge to edge: no padding around the photo.
    carousel: { finite: false, padding: 0 },
    // Mounts playing when a page header's Play opened the viewer.
    slideshow: { autoplay: slideshowActive, delay: 4000, ref: slideshowRef },
    // Solid: the page behind a see-through viewer reads as clutter around the photo.
    styles: { container: { backgroundColor: "#000" } },
    render: {
      // Returning undefined falls through to the default slide renderers
      // (image, and the Video plugin's player).
      slide: ({ slide }: { slide: Slide }) =>
        slide.type === "unplayable" ? unplayableSlide(slide) : undefined,
      // Our own Play: it switches the slides to the stills before playing.
      // Absent when there are only videos to show.
      buttonSlideshow: ({ playing, pause }: SlideshowRef) =>
        playing ? (
          <button
            key="slideshow"
            type="button"
            aria-label="Pause"
            onClick={pause}
            className={toolbarButtonClass}
          >
            <Pause className="h-6 w-6" aria-hidden="true" />
          </button>
        ) : hasStills ? (
          <button
            key="slideshow"
            type="button"
            aria-label="Play"
            onClick={playFromHere}
            className={toolbarButtonClass}
          >
            <Play className="h-6 w-6" aria-hidden="true" />
          </button>
        ) : null,
    },
  };
  const immersive = chromeHidden ? "yarl__immersive" : undefined;

  if (isDesktop) {
    if (!open) return null;
    const showDetails = desktopDetails && !chromeHidden;
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
            className={`fixed inset-0 z-40 flex bg-black/95 ${immersive ?? ""}`}
          >
            {sentinel("last")}
            <div
              ref={carouselCellRef}
              className="relative min-w-0 flex-1"
              {...tapHandlers}
            >
              <Lightbox
                {...common}
                plugins={[Inline, Zoom, Video, Counter, Thumbnails, Slideshow, Fullscreen]}
                inline={{ style: { width: "100%", height: "100%" } }}
                // Inline mode removes YARL's close action, and with it the only
                // visible way out of the viewer. Put a real button back in the
                // toolbar slot — Esc and click-away are not discoverable.
                toolbar={{
                  buttons: [
                    "slideshow",
                    // Fullscreen hides its own button where the browser can't.
                    "fullscreen",
                    // Not while fullscreen: the panel would open outside the
                    // fullscreen element, where it cannot be seen.
                    ...(fullscreen
                      ? []
                      : [
                          <button
                            key="details"
                            type="button"
                            aria-label="Details"
                            aria-pressed={desktopDetails}
                            title={desktopDetails ? "Hide details" : "Show details"}
                            onClick={toggleDesktopDetails}
                            className={`${toolbarButtonClass} ${desktopDetails ? "text-[#2680FC]" : ""}`}
                          >
                            <Info className="h-6 w-6" aria-hidden="true" />
                          </button>,
                        ]),
                    <button
                      key="close"
                      type="button"
                      aria-label="Close"
                      onClick={onClose}
                      className={toolbarButtonClass}
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
            {photo && showDetails && (
              <aside
                ref={panelRef}
                // The window capture listener skips the panel, so Escape that no
                // inner layer claimed still closes the viewer from in here.
                onKeyDown={(event) => {
                  if (event.key === "Escape") onClose();
                }}
                aria-label="Details"
                className="w-[340px] shrink-0 overflow-y-auto border-l border-[#4e4e4e] bg-[#2e2e2e] p-5"
              >
                <h2 className="mb-4 text-base font-semibold text-white">Details</h2>
                <PhotoInfo
                  photo={photo}
                  onEdit={startEdit}
                  onSetProject={startSetProject}
                  onNavigate={onClose}
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
        plugins={[Zoom, Video, Counter, Slideshow]}
        controller={{ closeOnBackdropClick: false }}
        className={immersive}
        portal={{ container: tapHandlers }}
        styles={{ ...common.styles, root: { zIndex: 40 } }}
        // A word, not an "i" alone: this is the only way to the photo's project,
        // albums, tags, and actions on a phone.
        toolbar={{
          buttons: [
            "slideshow",
            <button
              key="details"
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="mr-1 mt-1 flex min-h-11 items-center gap-2 rounded-full bg-black/55 px-4 text-base font-medium text-white backdrop-blur"
            >
              <Info className="h-5 w-5" aria-hidden="true" />
              Details
            </button>,
            "close",
          ],
        }}
        render={common.render}
      />
      <SheetShell
        open={detailsOpen && Boolean(photo)}
        onOpenChange={setDetailsOpen}
        title="Details"
        cancelLabel="Close"
      >
        {photo && (
          <PhotoInfo
            photo={photo}
            onEdit={startEdit}
            onSetProject={startSetProject}
            onNavigate={onClose}
          />
        )}
      </SheetShell>
      {editSheet}
    </>
  );
}
