// Folder rows: the unit of import choices (photo-albums plan, Decisions 9 and 10).
// Pure helpers shared by the browser, the server, and unit tests. No I/O here.

/** One row per folder that directly holds importable photos. */
export interface MigrationFolder {
  id: string; source_id: string;
  /** Path under the picked folder; '' is the picked folder itself. */
  folder: string;
  /** Null only for loose files, where an album is optional. */
  album_name: string | null;
  /** Set once the album exists (or, for loose files, when an existing album was chosen). */
  album_id: string | null;
  job_id: string | null;
  tags: string[];
  photo_count: number;
  jobs?: { id: string; job_number: string; name: string } | null;
  albums?: { id: string; name: string } | null;
}

/** The folder that directly holds a file: `a/b/c.jpg` -> `a/b`, `c.jpg` -> ''. */
export function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/');
  return cut < 0 ? '' : relativePath.slice(0, cut);
}

/** First path segment; '' for the picked folder itself. Review groups rows by this. */
export function topLevelFolder(folder: string): string {
  const cut = folder.indexOf('/');
  return cut < 0 ? folder : folder.slice(0, cut);
}

/** True when `folder` is `ancestor` or sits anywhere inside it. '' contains everything. */
export function isInsideFolder(folder: string, ancestor: string): boolean {
  return ancestor === '' || folder === ancestor || folder.startsWith(`${ancestor}/`);
}

export interface SuggestionJob { id: string; job_number: string }

/** Shorter project numbers ("7", "12") match too many ordinary folder names to be useful. */
export const MIN_SUGGESTION_NUMBER_LENGTH = 3;

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Project numbers that appear in `name` as a whole word: bounded on both sides by the
 * start, the end, or a character that is neither a letter nor a digit. `3612 Smith` and
 * `Smith-3612` match 3612; `13612` and `3612b` do not. A match inside a longer match is
 * dropped, so `24-015 Smith` means project 24-015 and not also project 015.
 */
export function projectNumbersIn(name: string, byNumber: ReadonlyMap<string, string>, longest: number): string[] {
  const text = name.toLowerCase();
  const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (isWordChar(text[i]) && !isWordChar(text[i - 1])) starts.push(i);
    if (isWordChar(text[i]) && !isWordChar(text[i + 1])) ends.push(i + 1);
  }
  const found: Array<{ start: number; end: number; id: string }> = [];
  for (const start of starts) for (const end of ends) {
    if (end <= start || end - start > longest) continue;
    const id = byNumber.get(text.slice(start, end));
    if (id) found.push({ start, end, id });
  }
  const outermost = found.filter(match => !found.some(other => other !== match &&
    other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
  return [...new Set(outermost.map(match => match.id))];
}

/**
 * Suggest a project for each folder from its name (AC-17). Walks from the folder itself up
 * through its parents and finally the picked folder's own name; the nearest name holding
 * exactly one project number wins, so `3612 Smith/Finished` inherits 3612. A name holding
 * two different numbers is ambiguous: the walk stops there and nothing is suggested.
 * Returns only folders that got a suggestion. It assigns nothing; review shows every one.
 */
export function suggestFolderProjects(folders: readonly string[], jobs: readonly SuggestionJob[], label: string): Map<string, string> {
  const byNumber = new Map<string, string>();
  let longest = 0;
  for (const job of jobs) {
    const number = job.job_number.trim().toLowerCase();
    if (number.length < MIN_SUGGESTION_NUMBER_LENGTH || !isWordChar(number[0]) || !isWordChar(number.at(-1))) continue;
    byNumber.set(number, job.id); longest = Math.max(longest, number.length);
  }
  const suggestions = new Map<string, string>();
  if (!byNumber.size) return suggestions;
  const seen = new Map<string, string[]>();
  const numbersIn = (name: string) => {
    let ids = seen.get(name);
    if (!ids) { ids = projectNumbersIn(name, byNumber, longest); seen.set(name, ids); }
    return ids;
  };
  for (const folder of folders) {
    const names = folder === '' ? [] : folder.split('/');
    for (const name of [...names.reverse(), label]) {
      const ids = numbersIn(name);
      if (ids.length === 0) continue;
      if (ids.length === 1) suggestions.set(folder, ids[0]);
      break;
    }
  }
  return suggestions;
}
