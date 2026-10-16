// The filters GET /api/photos and GET /api/photos/ids share: one parser for the
// query string, one search resolver, and one query builder, so "select all"
// always means exactly the photos the grid lists.
//
//   job       a project id, or `none` for photos with no project
//   album     an album id
//   uploader  a user id
//   tags      comma-separated; a photo must carry every one
//   type      one file-type label, lowercased: jpeg, heic, png, raw, video, other
//             (the labels of file-type.ts, decided by the same rules)
//   from, to  ISO instants with a zone (`2026-09-01T07:00:00.000Z`), inclusive on
//             captured_at. The server never picks a timezone: the browser turns
//             "This week" or a picked day into instants in its own local time.
//   q         search words split on whitespace; every word must match the
//             photo's project number or name, uploader name, a tag, or its name
//             (display or original)
//   sort      asc | desc (default desc), on (captured_at, id); or `custom` with
//             `album`: the album's arranged order, (album_position, id) ascending,
//             read from the album_photo_order view
//   favorites `1`: only the signed-in person's favorites (the
//             photo_favorite_photos view, which holds only their rows)
// Filters combine with AND.
//
// A cursor names the order it continues: [captured_at, id] for date order, and
// ['position:<n>', id] for custom order, so neither is ever read as the other.

import { validate as isUuid } from 'uuid';
import { escapeIlikeWildcards } from '../apiShared';
import { FILE_TYPE_LABELS, fileTypeSignals, type FileTypeLabel } from '../file-type';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  isIsoTimestamp,
  keysetOrFilter,
  type KeysetDirection,
} from '@/lib/keysetCursor';
import type { PhotoTagRow } from '../types';
import type { createSupabaseServerClient } from '@/lib/supabaseServerClient';

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** `job=none`: photos with no project. */
const NO_PROJECT = 'none';
/** Most words one search may hold; each costs three lookups and one or() group. */
export const MAX_SEARCH_WORDS = 8;
// Upper bound on tags spliced into one or() filter — a URL-length guard, not a
// recall choice; the type-ahead (/api/photo-tags) is unbounded.
const MAX_SEARCH_TAGS = 500;

export interface PhotoFilters {
  job: string | null;
  noProject: boolean;
  album: string | null;
  uploader: string | null;
  tags: string[];
  type: FileTypeLabel | null;
  from: string | null;
  to: string | null;
  /** Search words, already split; null when there is no search. */
  words: string[] | null;
  direction: KeysetDirection;
  /** `sort=custom`: the album's arranged order (always ascending). Only with `album`. */
  custom: boolean;
  /** `favorites=1`: only the reader's own favorites. */
  favorites: boolean;
}

/** Search words: whitespace-separated; characters that are PostgREST filter grammar separate words too. */
export function searchWords(q: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of q.replace(/[,()"*]/g, ' ').split(/\s+/)) {
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    words.push(word);
  }
  return words;
}

/** Parse the shared filters; a string is the 400 message for a malformed one. */
export function parsePhotoFilters(params: URLSearchParams): PhotoFilters | string {
  const jobParam = params.get('job');
  const noProject = jobParam === NO_PROJECT;
  const job = noProject ? null : jobParam || null;
  const album = params.get('album') || null;
  const uploader = params.get('uploader') || null;
  const tags = (params.get('tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const typeParam = params.get('type') || null;
  const from = params.get('from') || null;
  const to = params.get('to') || null;
  const q = params.get('q')?.trim() || null;
  const sort = params.get('sort') || null;
  const favoritesParam = params.get('favorites');

  if (job && !isUuid(job)) return 'Invalid job id';
  if (favoritesParam !== null && favoritesParam !== '1') return 'Invalid favorites';
  if (album && !isUuid(album)) return 'Invalid album id';
  if (uploader && !isUuid(uploader)) return 'Invalid uploader id';
  if (sort !== null && sort !== 'asc' && sort !== 'desc' && sort !== 'custom') return 'Invalid sort';
  if (sort === 'custom' && !album) return 'sort=custom needs an album';
  const type = typeParam === null ? null : FILE_TYPE_LABELS.find((label) => label.toLowerCase() === typeParam);
  if (type === undefined) return 'Invalid type';
  if (from !== null && !isIsoTimestamp(from)) return 'Invalid from';
  if (to !== null && !isIsoTimestamp(to)) return 'Invalid to';
  // A query of nothing but separators ("()") is no search at all.
  const split = q === null ? [] : searchWords(q);
  const words = split.length > 0 ? split : null;
  if (words && words.length > MAX_SEARCH_WORDS) return `Search at most ${MAX_SEARCH_WORDS} words`;

  const custom = sort === 'custom';
  return { job, noProject, album, uploader, tags, type, from, to, words, direction: sort === 'desc' || sort === null ? 'desc' : 'asc', custom, favorites: favoritesParam === '1' };
}

// --- order and cursor ----------------------------------------------------------

const POSITION_PREFIX = 'position:';
/** A position as PostgREST returns it: a JSON number, or "Infinity" for a photo with no position. */
const POSITION = /^(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|Infinity)$/;

/** The column a walk sorts on before its `id` tiebreaker. */
export const sortColumn = (filters: PhotoFilters) => (filters.custom ? 'album_position' : 'captured_at');

/** A row a walk stops on: its id and its sort column's value. */
export type KeysetRow = { id: string; captured_at?: string; album_position?: number | string };

/** Where a walk stands: the sort column's value and the id, both safe to put in a filter. */
export interface KeysetPosition { key: string; id: string }

/** The cursor that continues after `row`. */
export function encodePhotoCursor(filters: PhotoFilters, row: KeysetRow): string {
  return filters.custom
    ? encodeKeysetCursor(`${POSITION_PREFIX}${String(row.album_position)}`, row.id)
    : encodeKeysetCursor(row.captured_at!, row.id);
}

/** A cursor this order handed out, or null for anything else (another order's cursor included). */
export function decodePhotoCursor(filters: PhotoFilters, raw: string): KeysetPosition | null {
  return decodeKeysetCursor(raw, (first, id) => {
    if (!isUuid(id)) return null;
    if (!filters.custom) return isIsoTimestamp(first) ? { key: first, id } : null;
    const key = first.startsWith(POSITION_PREFIX) ? first.slice(POSITION_PREFIX.length) : '';
    return POSITION.test(key) ? { key, id } : null;
  });
}

/** The keyset position of a row the walk just read. */
export const rowPosition = (filters: PhotoFilters, row: KeysetRow): KeysetPosition => ({
  key: filters.custom ? String(row.album_position) : row.captured_at!,
  id: row.id,
});

/** PostgREST or() body for "past this position" in the walk's order. */
export const afterFilter = (filters: PhotoFilters, position: KeysetPosition) =>
  keysetOrFilter(sortColumn(filters), position.key, 'id', position.id, filters.direction);

/**
 * The plain bound that goes with afterFilter: the sort column at or past the
 * cursor's value. It selects nothing afterFilter does not already allow, but
 * Postgres cannot start an index scan from an or(); from this it can, so a deep
 * page reads about one page of rows instead of every row before it.
 */
export const afterBound = (filters: PhotoFilters, position: KeysetPosition) => ({
  column: sortColumn(filters),
  operator: filters.direction === 'asc' ? 'gte' : 'lte',
  value: position.key,
});

/** The part of a PostgREST query pastPosition needs. */
interface FilterableQuery<Q> {
  or(filters: string): Q;
  filter(column: string, operator: string, value: unknown): Q;
}

/** `query` continued strictly past `position`: afterFilter, plus afterBound for the index. */
export function pastPosition<Q extends FilterableQuery<Q>>(query: Q, filters: PhotoFilters, position: KeysetPosition): Q {
  const bound = afterBound(filters, position);
  // Separate or() calls are ANDed by PostgREST, so this composes with the filters.
  return query.or(afterFilter(filters, position)).filter(bound.column, bound.operator, bound.value);
}

// --- file type ---------------------------------------------------------------

const nameEndsIn = (extensions: string[]) =>
  // `_%` keeps extensionOf's rule that a leading dot (".jpg") is no extension.
  extensions.map((ext) => `original_name.ilike._%.${ext}`).join(',');
const mimeIs = (mimes: string[]) => mimes.map((mime) => `mime_type.ilike.${mime}`).join(',');

/**
 * One PostgREST or() body selecting the photos `fileTypeLabel` gives `label`.
 * Null-safe: a missing name or MIME type is "no signal", as it is in fileTypeLabel.
 */
export function fileTypeFilter(label: FileTypeLabel): string {
  const signals = fileTypeSignals();
  const all = Object.values(signals);
  const noNameLabel = `or(original_name.is.null,not.or(${nameEndsIn(all.flatMap((s) => s.extensions))}))`;
  const noMimeLabel = `or(mime_type.is.null,not.or(${mimeIs(all.flatMap((s) => s.mimes))}))`;
  if (label === 'Video') return `kind.eq.video,and(${noNameLabel},mime_type.ilike.video/%)`;
  if (label === 'Other') {
    return `and(kind.neq.video,${noNameLabel},${noMimeLabel},or(mime_type.is.null,mime_type.not.ilike.video/%))`;
  }
  const { extensions, mimes } = signals[label];
  return `and(kind.neq.video,or(${nameEndsIn(extensions)},and(${noNameLabel},or(${mimeIs(mimes)}))))`;
}

// --- search ------------------------------------------------------------------

/**
 * One PostgREST or() body per search word: the photo's names, plus the projects,
 * uploaders, and tags the word matches. Each word's body is applied as its own
 * or() call, which PostgREST ANDs. `job` scopes the tag lookup, which would
 * otherwise unnest the tags of every photo to answer a one-project question.
 */
export async function resolveSearch(supabase: ServerClient, filters: PhotoFilters): Promise<string[]> {
  if (!filters.words) return [];
  return Promise.all(filters.words.map(async (word) => {
    const escaped = escapeIlikeWildcards(word);
    const pattern = `%${escaped}%`;
    const [jobsResult, uploadersResult, tagRowsResult] = await Promise.all([
      supabase.from('jobs').select('id').or(`job_number.ilike.${pattern},name.ilike.${pattern}`).limit(200),
      supabase.from('user_profiles').select('user_id').ilike('full_name', pattern).limit(200),
      supabase.rpc('get_photo_tags', { job_filter: filters.job, q: escaped }),
    ]);
    const firstError = jobsResult.error ?? uploadersResult.error ?? tagRowsResult.error;
    if (firstError) throw new Error(firstError.message);

    const parts = [`display_name.ilike.${pattern}`, `original_name.ilike.${pattern}`];
    const jobIds = (jobsResult.data ?? []).map((row) => row.id);
    if (jobIds.length > 0) parts.push(`job_id.in.(${jobIds.join(',')})`);
    const uploaderIds = (uploadersResult.data ?? []).map((row) => row.user_id);
    if (uploaderIds.length > 0) parts.push(`uploader_id.in.(${uploaderIds.join(',')})`);
    // Drop tags that can't be embedded in PostgREST's or()/array syntax. The UI
    // never produces those, so skipping is the safe trade.
    const matchedTags = ((tagRowsResult.data ?? []) as PhotoTagRow[])
      .map((row) => row.tag)
      .filter((tag) => !/[,(){}"\\]/.test(tag))
      .slice(0, MAX_SEARCH_TAGS);
    if (matchedTags.length > 0) parts.push(`tags.ov.{${matchedTags.join(',')}}`);
    return parts.join(',');
  }));
}

// --- query -------------------------------------------------------------------

/**
 * Where a list reads its rows. Each source starts from the smallest set that
 * can match, so the cost follows the album or the favorites, not the library:
 *   album      the album_photo_order view (an album's active photos with their
 *              place in its custom order), for date order too. Read through
 *              PostgREST's old `albums!inner` join, a small album walked every
 *              photo in the library looking for matches.
 *   favorites  the photo_favorite_photos view (the reader's own favorites).
 *   otherwise  photos.
 * Both views are SECURITY INVOKER and read with the employee's session, so the
 * photos, album_photos and albums row rules still apply (a deleted album lists
 * nothing). Album and favorites together read the album and keep only the
 * favorites through an inner embed, whose row rule shows only the reader's own.
 */
export const photoSource = (filters: PhotoFilters) =>
  filters.album ? 'album_photo_order' : filters.favorites ? 'photo_favorite_photos' : 'photos';

/** Album plus favorites keeps only the reader's favorites with this inner embed. */
const FAVORITES_FILTER = 'favorites:photo_favorites!inner(user_id)';

/**
 * The columns GET /api/photos selects: `columns`, `album_position` for custom
 * order (the cursor needs it), and the reader's own favorite on each row from
 * `embed` (FAVORITES_EMBED), unless filteredPhotos already brings that column.
 */
export const listColumns = (filters: PhotoFilters, columns: string, embed: string) =>
  [columns, filters.custom ? 'album_position' : null, filters.album && filters.favorites ? null : embed]
    .filter(Boolean).join(', ');

/**
 * Active photos matching `filters`, in the walk's order, selecting `columns`
 * from photoSource. `search` is resolveSearch's output for the same filters.
 * Every filter applies the same way to each source.
 */
export function filteredPhotos(
  supabase: ServerClient,
  filters: PhotoFilters,
  search: string[],
  columns: string,
  options: { count?: 'exact' } = {}
) {
  // The inner embed doubles as the `favorites` column the grid reads; listColumns leaves it out.
  if (filters.album && filters.favorites) columns = `${columns}, ${FAVORITES_FILTER}`;
  const ascending = filters.direction === 'asc';
  let query = supabase.from(photoSource(filters)).select(columns, options)
    .is('deleted_at', null)
    .order(sortColumn(filters), { ascending })
    .order('id', { ascending });

  if (filters.album) query = query.eq('album_id', filters.album);
  if (filters.job) query = query.eq('job_id', filters.job);
  if (filters.noProject) query = query.is('job_id', null);
  if (filters.uploader) query = query.eq('uploader_id', filters.uploader);
  for (const tag of filters.tags) query = query.contains('tags', [tag]);
  if (filters.type) query = query.or(fileTypeFilter(filters.type));
  if (filters.from) query = query.gte('captured_at', filters.from);
  if (filters.to) query = query.lte('captured_at', filters.to);
  // Separate or() calls are ANDed by PostgREST: one group per search word.
  for (const group of search) query = query.or(group);
  return query;
}
