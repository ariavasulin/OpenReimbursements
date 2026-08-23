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
  knownTags: string[] | TagPair[],
  input: string,
  tags: string[],
  limit = 6
): string[] {
  const query = input.trim().toLowerCase();
  if (!query) return [];
  const pairs: TagPair[] =
    typeof knownTags[0] === "string"
      ? toTagPairs(knownTags as string[])
      : (knownTags as TagPair[]);
  const out: string[] = [];
  for (const [tag, lower] of pairs) {
    if (out.length >= limit) break;
    if (lower.includes(query) && !tags.includes(tag)) out.push(tag);
  }
  return out;
}
