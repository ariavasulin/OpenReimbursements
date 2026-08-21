import type { PhotoJobSummary } from "./types";

/** Lower is better; null means "not a match". */
function rank(job: PhotoJobSummary, query: string, words: string[]): number | null {
  const number = job.job_number.toLowerCase();
  if (number === query) return 0;
  if (number.startsWith(query)) return 1;

  const nameWords = job.name.toLowerCase().split(/\s+/).filter(Boolean);
  const everyWordIsPrefix = words.every((word) =>
    nameWords.some((nameWord) => nameWord.startsWith(word))
  );
  if (everyWordIsPrefix) return 2;

  if (job.name.toLowerCase().includes(query)) return 3;
  return null;
}

/**
 * Jobs matching `query`, best first: exact job number, then job-number
 * prefix, then every query word a prefix of some word in the name, then a
 * plain substring of the name. Case-insensitive. Ties keep the input order
 * (the API's most-recent-activity order), so an empty query returns the
 * first `limit` jobs untouched.
 */
export function filterJobs(
  jobs: PhotoJobSummary[],
  query: string,
  limit = 8
): PhotoJobSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return jobs.slice(0, limit);
  const words = normalized.split(/\s+/).filter(Boolean);

  const ranked: { job: PhotoJobSummary; score: number }[] = [];
  for (const job of jobs) {
    const score = rank(job, normalized, words);
    if (score !== null) ranked.push({ job, score });
  }
  // Array.prototype.sort is stable, so equal scores keep API order.
  ranked.sort((a, b) => a.score - b.score);
  return ranked.slice(0, limit).map((entry) => entry.job);
}
