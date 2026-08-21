export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns every photos response returns (uploader name + job embedded). */
export const PHOTO_COLUMNS =
  'id, job_id, uploader_id, kind, sheet_number, tags, captured_at, ' +
  'original_path, original_bytes, mime_type, original_name, thumb_path, ' +
  'preview_path, duration_secs, created_at, ' +
  'uploader:user_profiles(full_name), job:jobs(id, job_number, name)';

/** Escape ILIKE wildcards and strip PostgREST or()-syntax characters. */
export function escapeForIlike(raw: string): string {
  return raw
    .replace(/[%_\\]/g, (m) => `\\${m}`)
    .replace(/[,()]/g, ' ')
    .trim();
}

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 64;

/** Dedupe/trim/cap a client-supplied tags value; non-arrays become []. */
export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean)
    ),
  ].slice(0, MAX_TAGS);
}
