/** A known tag paired with its lowercase form, so matching lowercases once. */
export type TagPair = readonly [tag: string, lower: string];

export function toTagPairs(knownTags: string[]): TagPair[] {
  return knownTags.map((tag) => [tag, tag.toLowerCase()]);
}

/**
 * Known tags containing `input` (case-insensitive), minus the ones already
 * chosen, capped at `limit`. Blank input suggests nothing.
 */
export function tagSuggestions(
  pairs: TagPair[],
  input: string,
  tags: string[],
  limit = 6
): string[] {
  const query = input.trim().toLowerCase();
  if (!query) return [];
  const out: string[] = [];
  for (const [tag, lower] of pairs) {
    if (out.length >= limit) break;
    if (lower.includes(query) && !tags.includes(tag)) out.push(tag);
  }
  return out;
}

/** `tags` plus the trimmed `raw` tag; the same array when blank or already present. */
export function appendTag(tags: string[], raw: string): string[] {
  const tag = raw.trim();
  return tag && !tags.includes(tag) ? [...tags, tag] : tags;
}

/** The job / sheet # / tags form values shared by the upload and edit sheets. */
export interface PhotoMeta {
  /** Selected job id, or "" for none. */
  jobId: string;
  sheetNumber: string;
  tags: string[];
  /** Half-typed tag; appended as one more tag on save. */
  tagInput: string;
}

/** Adds the tag and clears the half-typed input in one state transition. */
export function addTagToMeta(meta: PhotoMeta, tag: string): PhotoMeta {
  return { ...meta, tags: appendTag(meta.tags, tag), tagInput: "" };
}
