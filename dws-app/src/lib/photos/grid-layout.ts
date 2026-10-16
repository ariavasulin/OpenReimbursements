// The photo grid marks each group section `content-visibility: auto`, so the
// browser skips layout and paint for sections far off screen: a project with
// thousands of loaded photos then costs about what one screenful does.
//
// A skipped section is as tall as its `contain-intrinsic-size`. Until a
// section has been drawn once, that is our guess below; with the `auto`
// keyword the browser then remembers the real height. The guess only has to
// be close: it sets the scrollbar's length and how far below the last group
// the "load more" sentinel sits before those sections are first drawn.

export interface TileLayoutGuess {
  /** Tiles per row. */
  columns: number;
  /** One row: a tile's height plus the gap under it, in px. */
  rowPx: number;
}

/** A 390px phone: 3 columns of ~115px tiles (page padding 16px, gap 6px). */
export const PHONE_TILES: TileLayoutGuess = { columns: 3, rowPx: 122 };

/** A 1440px screen beside the 280px rail: 7 columns of ~150px tiles, gap 8px. */
export const DESKTOP_TILES: TileLayoutGuess = { columns: 7, rowPx: 158 };

/** The group header row (44px) and the small margin above it. */
const HEADER_PX = 48;

/** Estimated height in px of a group section holding `count` tiles. */
export function sectionHeightGuess(count: number, layout: TileLayoutGuess): number {
  return HEADER_PX + Math.ceil(Math.max(0, count) / layout.columns) * layout.rowPx;
}
