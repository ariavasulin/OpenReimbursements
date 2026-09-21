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

/** Always offered, even before any photo carries them (photo-albums Decision 5). */
export const STARTER_TAGS = ["professional", "field dimension", "shop drawing"] as const;

/** What a tag is, in one sentence, wherever tags are chosen. */
export const TAG_EXPLAINER =
  "A tag is a label you can filter by, like professional or shop drawing.";

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every tag the dropdown offers: the tags already in use plus the starter tags,
 * one spelling each (an existing spelling wins over a starter's), A to Z
 * ignoring case.
 */
export function tagChoices(knownTags: string[]): string[] {
  const out: string[] = [];
  for (const tag of [...knownTags, ...STARTER_TAGS]) {
    if (tag.trim() && !out.some((have) => sameTag(have, tag))) out.push(tag);
  }
  return out.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/**
 * The spelling to store for what was typed: the existing or starter tag that
 * matches ignoring case, else the trimmed text. "Professional" -> "professional".
 */
export function resolveTag(typed: string, choices: string[]): string {
  const tag = typed.trim();
  return choices.find((choice) => sameTag(choice, tag)) ?? tag;
}

/** What the open dropdown lists for the typed text. */
export interface TagMenu {
  /** Choices not already picked that contain the typed text, ignoring case. */
  options: string[];
  /** The text for the last row, `Add "<typed>"`; null when it is blank, already
   *  picked, or is one of the choices (ignoring case) — then that choice is listed. */
  add: string | null;
}

export function tagMenu(choices: string[], chosen: string[], input: string): TagMenu {
  const typed = input.trim();
  const query = typed.toLowerCase();
  const isChosen = (tag: string) => chosen.some((have) => sameTag(have, tag));
  const options = choices.filter(
    (choice) => !isChosen(choice) && choice.toLowerCase().includes(query)
  );
  const known = choices.some((choice) => sameTag(choice, typed));
  return { options, add: typed && !known && !isChosen(typed) ? typed : null };
}

/**
 * `tags` plus what was typed, resolved to an existing spelling first; the same
 * array when blank or already present (ignoring case).
 */
export function appendResolvedTag(tags: string[], raw: string, choices: string[]): string[] {
  const tag = resolveTag(raw, choices);
  return tag && !tags.some((have) => sameTag(have, tag)) ? [...tags, tag] : tags;
}

/** `tags` plus the trimmed `raw` tag; the same array when blank or already present. */
export function appendTag(tags: string[], raw: string): string[] {
  const tag = raw.trim();
  return tag && !tags.includes(tag) ? [...tags, tag] : tags;
}

/** The project / albums / tags form values shared by the upload and edit pop-ups. */
export interface PhotoMeta {
  /** Selected project id, or "" for none. */
  jobId: string;
  /** Albums the photos join (upload only). */
  albums: { id: string; name: string }[];
  tags: string[];
  /** Half-typed tag; appended as one more tag on save. */
  tagInput: string;
}

/** Adds the tag and clears the half-typed input in one state transition. */
export function addTagToMeta(meta: PhotoMeta, tag: string): PhotoMeta {
  return { ...meta, tags: appendTag(meta.tags, tag), tagInput: "" };
}
