// Upload sizes that both the upload steps (upload.ts) and the resumable
// transfer (upload-tus.ts) need. They live here, apart from upload-tus.ts,
// because importing them from there would pull tus-js-client into every
// bundle that only needs the numbers (SHELL-2).

/** Plain .upload() is for <=6 MB; anything bigger goes resumable (TUS). */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;
/** Supabase's TUS endpoint requires chunks of EXACTLY 6 MB. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
