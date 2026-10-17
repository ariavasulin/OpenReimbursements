// How long browsers and the storage CDN may keep a photos-bucket file
// without asking again, sent as `cacheControl` with every upload (Supabase
// stores it and serves `cache-control: max-age=<seconds>`). Left unset,
// supabase-js sends one hour, so every revisit after an hour turned each
// tile into a "has this changed?" request and every CDN miss cost ~1 s.
//
// Long caching is safe only because these files are write-once in what
// they show; the rule is spelled out on derivedKeys (repair/sweep.ts).

/** Thumbnails, previews, video posters and playback renditions: one year.
 * Their keys are fixed per photo and only ever hold that photo's picture. */
export const DERIVED_CACHE_SECONDS = "31536000";

/** Originals and sidecars: one week. They are opened rarely (downloads and
 * video playback), so a longer life gains little, and a purged original
 * should not stay in caches for a year. */
export const ORIGINAL_CACHE_SECONDS = "604800";
