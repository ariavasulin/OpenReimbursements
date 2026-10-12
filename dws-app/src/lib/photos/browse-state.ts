// What a photo grid is showing, as URL state: `?project=&uploader=&tags=&type=
// &from=&to=&sort=&group=`. A reload or a pasted link restores it, and Clear
// empties it. The page's own scope (a project's `job`, an album, a search's `q`)
// is not a filter and is never written here. Pure — no DOM, no React.
//
//   project   a project id, or `none` (Photos and search only)
//   uploader  a user id
//   tags      comma-joined; a photo must carry every one
//   type      one file-type label, lowercased (`raw`)
//   from, to  ISO instants (`toISOString()`), inclusive on captured_at. Dates
//             are turned into instants here, in the browser's local time: the
//             server never picks a timezone.
//   sort      `asc` (Oldest), `desc` (Newest), `custom` (an album's arranged
//             order, album pages only); absent is the page's default sort
//   group     a Group by mode; absent is the page's first mode

import { isIsoTimestamp } from "@/lib/keysetCursor";
import type { PhotoSort } from "./api";
import { FILE_TYPE_LABELS, type FileTypeLabel } from "./file-type";
import type { GroupBy, PhotoGroup } from "./group";

export interface BrowseFilters {
  /** A project id, or `none` for photos with no project. */
  project: string | null;
  uploader: string | null;
  tags: string[];
  type: FileTypeLabel | null;
  from: string | null;
  to: string | null;
}

export interface BrowseState {
  filters: BrowseFilters;
  sort: PhotoSort;
  group: GroupBy;
}

export interface BrowseOptions {
  /** Group modes the page offers; the first is the default. */
  groupModes: readonly GroupBy[];
  /** Whether this page filters by project (Photos and search; not a project or an album). */
  projectFilter: boolean;
  /** The sort with no `sort` in the URL; Newest unless the page says (an arranged album). */
  defaultSort?: PhotoSort;
  /** Whether `custom` is a choice here (an album page). */
  customSort?: boolean;
}

export const NO_FILTERS: BrowseFilters = {
  project: null,
  uploader: null,
  tags: [],
  type: null,
  from: null,
  to: null,
};

/** Every query-string key this module owns; anything else (`q`, `photo`) is left alone. */
export const BROWSE_KEYS = ["project", "uploader", "tags", "type", "from", "to", "sort", "group"] as const;

/** `project=none` and GET /api/photos `job=none`: photos with no project. */
export const NO_PROJECT_VALUE = "none";

const typeFromParam = (value: string | null): FileTypeLabel | null =>
  FILE_TYPE_LABELS.find((label) => label.toLowerCase() === value) ?? null;

const instantOrNull = (value: string | null) => (value && isIsoTimestamp(value) ? value : null);

function splitTags(value: string | null): string[] {
  const tags = (value ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
  return [...new Set(tags)];
}

function parseSort(value: string | null, options: BrowseOptions): PhotoSort {
  if (value === "asc" || value === "desc") return value;
  if (value === "custom" && options.customSort) return value;
  return options.defaultSort ?? "desc";
}

/** The state a query string describes. Unknown or malformed values read as unset. */
export function parseBrowseState(
  search: string | URLSearchParams,
  options: BrowseOptions
): BrowseState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const group = params.get("group") as GroupBy | null;
  return {
    filters: {
      project: options.projectFilter ? params.get("project") || null : null,
      uploader: params.get("uploader") || null,
      tags: splitTags(params.get("tags")),
      type: typeFromParam(params.get("type")),
      from: instantOrNull(params.get("from")),
      to: instantOrNull(params.get("to")),
    },
    sort: parseSort(params.get("sort"), options),
    group: group && options.groupModes.includes(group) ? group : options.groupModes[0],
  };
}

/**
 * `search` with this module's keys replaced by `state`, defaults left out so a
 * plain grid keeps a plain URL. Other keys keep their place. Returns "" or "?…".
 */
export function writeBrowseState(
  search: string,
  state: BrowseState,
  options: BrowseOptions
): string {
  const params = new URLSearchParams(search);
  for (const key of BROWSE_KEYS) params.delete(key);
  const { filters } = state;
  if (options.projectFilter && filters.project) params.set("project", filters.project);
  if (filters.uploader) params.set("uploader", filters.uploader);
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.type) params.set("type", filters.type.toLowerCase());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (state.sort !== (options.defaultSort ?? "desc")) params.set("sort", state.sort);
  if (state.group !== options.groupModes[0]) params.set("group", state.group);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** One per thing a person would take away on its own: each tag counts. */
export function activeFilterCount(filters: BrowseFilters): number {
  return (
    (filters.project ? 1 : 0) +
    (filters.uploader ? 1 : 0) +
    filters.tags.length +
    (filters.type ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0)
  );
}

/**
 * The filters and sort as GET /api/photos (and /ids) parameters, added to the
 * page's scope parameters. The URL's `project` is the API's `job`.
 */
export function withFilterParams(
  scope: URLSearchParams,
  filters: BrowseFilters,
  sort: PhotoSort
): URLSearchParams {
  const params = new URLSearchParams(scope);
  if (filters.project) params.set("job", filters.project);
  if (filters.uploader) params.set("uploader", filters.uploader);
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.type) params.set("type", filters.type.toLowerCase());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (sort !== "desc") params.set("sort", sort);
  return params;
}

// ---- Dates ---------------------------------------------------------------------

export type DatePreset = "week" | "month" | "year";

export const DATE_PRESETS: readonly { value: DatePreset; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
];

export interface DateRange {
  from: string | null;
  to: string | null;
}

/** The last millisecond before `next`: an inclusive end that stops short of the next day. */
const endBefore = (next: Date) => new Date(next.getTime() - 1).toISOString();

/** A local day, start to end, as instants. */
export function localDayRange(day: Date): { from: string; to: string } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return { from: start.toISOString(), to: endBefore(next) };
}

/** This week (Sunday to Saturday), month, or year, in local time, around `now`. */
export function presetRange(preset: DatePreset, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const [start, next] =
    preset === "week"
      ? [new Date(y, m, d - now.getDay()), new Date(y, m, d - now.getDay() + 7)]
      : preset === "month"
        ? [new Date(y, m, 1), new Date(y, m + 1, 1)]
        : [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
  return { from: start.toISOString(), to: endBefore(next) };
}

/** Which preset a range is, if any (as of `now`). */
export function matchingPreset(range: DateRange, now = new Date()): DatePreset | null {
  for (const { value } of DATE_PRESETS) {
    const preset = presetRange(value, now);
    if (range.from === preset.from && range.to === preset.to) return value;
  }
  return null;
}

/** `YYYY-MM-DD` (an `<input type="date">` value) as a local Date, or null. */
function parseDayInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

/** The local day an instant falls on, as an `<input type="date">` value. */
export function toDayInput(instant: string | null): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A picked range of whole local days: `from` the first day's start, `to` the
 * last day's end. Either end may be empty; a reversed pair is put in order.
 * Null when neither end is a day.
 */
export function customRange(fromDay: string, toDay: string): DateRange | null {
  let first = parseDayInput(fromDay), last = parseDayInput(toDay);
  if (!first && !last) return null;
  if (first && last && first > last) [first, last] = [last, first];
  return {
    from: first ? localDayRange(first).from : null,
    to: last ? localDayRange(last).to : null,
  };
}

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const LONG_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** How a date filter reads on its chip: "This month", "Mar 1 – Mar 3, 2032", "From Mar 1, 2032". */
export function dateFilterLabel(range: DateRange, now = new Date()): string {
  const preset = matchingPreset(range, now);
  if (preset) return DATE_PRESETS.find((option) => option.value === preset)!.label;
  const from = range.from ? new Date(range.from) : null;
  const to = range.to ? new Date(range.to) : null;
  if (from && to) {
    if (toDayInput(range.from) === toDayInput(range.to)) return LONG_DAY.format(from);
    const sameYear = from.getFullYear() === to.getFullYear();
    return `${(sameYear ? SHORT_DAY : LONG_DAY).format(from)} – ${LONG_DAY.format(to)}`;
  }
  if (from) return `From ${LONG_DAY.format(from)}`;
  if (to) return `Until ${LONG_DAY.format(to)}`;
  return "Any date";
}

// ---- Group header ticks ----------------------------------------------------------

const later = (a: string | null, b: string) => (a !== null && Date.parse(a) > Date.parse(b) ? a : b);
const earlier = (a: string | null, b: string) => (a !== null && Date.parse(a) < Date.parse(b) ? a : b);

/**
 * The filters that list exactly one group, loaded or not: the grid's filters
 * narrowed by the group's own predicate. Null for a group no filter can name
 * ("No tags", an uploader with no name, an unknown date); the tick then takes
 * the photos that are loaded.
 */
export function groupFilters(group: PhotoGroup, filters: BrowseFilters): BrowseFilters | null {
  const split = group.key.indexOf(":");
  const kind = group.key.slice(0, split), value = group.key.slice(split + 1);
  if (kind === "date") {
    const first = group.photos[0];
    const day = first ? new Date(first.captured_at) : null;
    if (value === "unknown" || !day || Number.isNaN(day.getTime())) return null;
    const range = localDayRange(day);
    return { ...filters, from: later(filters.from, range.from), to: earlier(filters.to, range.to) };
  }
  if (kind === "tag") {
    return value === "none" ? null : { ...filters, tags: [...new Set([...filters.tags, value])] };
  }
  if (kind === "uploader") return value === "unknown" ? null : { ...filters, uploader: value };
  if (kind === "type") return { ...filters, type: typeFromParam(value.toLowerCase()) ?? null };
  if (kind === "job") return { ...filters, project: value };
  // An arranged album shows one ungrouped list: its tick is every match.
  if (kind === "custom") return filters;
  return null;
}
