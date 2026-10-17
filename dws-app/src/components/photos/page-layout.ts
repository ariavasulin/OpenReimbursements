/**
 * The <main> every photos page shares. pb-40 at phone width leaves the last row
 * of photos clear of the floating "+" button, the upload tray, and a selection
 * bar that wraps to three lines.
 */
export const PAGE_MAIN_CLASS =
  "mx-auto w-full max-w-3xl px-4 pb-40 pt-4 lg:max-w-6xl lg:px-8 desktop:max-w-none desktop:px-8 desktop:pb-10 desktop:pt-5";

/** The page's name: the one h1. */
export const PAGE_TITLE_CLASS = "break-words text-xl font-semibold leading-snug text-white";

/** The one-line explainer under a section's name, and other secondary lines. */
export const PAGE_SUBTITLE_CLASS = "mt-1 text-base text-[#b4b4b4]";

/** A grid of photo tiles: the grid itself, Arrange, and the loading skeleton. */
export const TILE_GRID_CLASS =
  "grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 desktop:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] desktop:gap-2";

/** The Projects and Albums card grid, and its loading skeleton. */
export const CARD_GRID_CLASS = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";
