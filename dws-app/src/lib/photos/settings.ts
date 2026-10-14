// The Settings page's values: the app-wide default tags (photo_settings, edited
// by photo admins) and the signed-in person's own slideshow setting
// (user_profiles.slideshow_*). GET/PATCH /api/photos/settings carries them.

/** Seconds a slideshow photo stays on screen: the choices the page offers. */
export const SLIDESHOW_DELAY_CHOICES = [2, 3, 4, 5, 8, 10, 15, 20, 30] as const;

/** What a fresh account has: in order, 4 s each, as the viewer always played. */
export const DEFAULT_SLIDESHOW = { shuffle: false, delay_seconds: 4 } as const;

export interface SlideshowSettings {
  /** Random order instead of the grid's order. */
  shuffle: boolean;
  delay_seconds: number;
}

export interface PhotoSettings {
  /** The default tags every picker offers before any photo carries them. */
  starter_tags: string[];
  slideshow: SlideshowSettings;
}

/** What PATCH /api/photos/settings accepts: any part, the rest unchanged. */
export interface PhotoSettingsPatch {
  starter_tags?: string[];
  slideshow?: Partial<SlideshowSettings>;
}

/**
 * The slideshow's playing order for `count` stills: a random permutation when
 * shuffling, else 0..count-1. `previous` is the order already playing; it is
 * kept and only the stills added since (loaded as the slideshow neared the end
 * of a page) are shuffled in behind it, so a running slideshow never repeats or
 * skips because more photos arrived.
 */
export function slideshowOrder(count: number, shuffle: boolean, previous: readonly number[] = [], random = Math.random): number[] {
  if (!shuffle) return Array.from({ length: count }, (_, at) => at);
  const kept = previous.filter((at) => at < count);
  const have = new Set(kept);
  const added = [];
  for (let at = 0; at < count; at += 1) if (!have.has(at)) added.push(at);
  for (let at = added.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [added[at], added[other]] = [added[other], added[at]];
  }
  return [...kept, ...added];
}
