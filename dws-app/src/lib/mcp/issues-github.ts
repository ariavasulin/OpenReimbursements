import 'server-only';
import { ISSUE_LABELS, ISSUE_REPOSITORY, formatIssueBody, issueMarker, type IssuePayload } from './issues-validation';

export type GithubOutcome = { status: 'published'; number: number; url: string } |
  { status: 'failed' | 'unknown'; code: string; retryAt?: string };

function loopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
}

/** The only production target is GitHub; test overrides cannot redirect credentials remotely. */
function configuration(): { base: string; token: string } {
  const token = process.env.DWS_GITHUB_ISSUES_TOKEN;
  if (!token) throw new Error('Issue publication is not configured.');
  let base = 'https://api.github.com';
  if (process.env.DWS_TEST_GITHUB_API_URL) {
    const url = new URL(process.env.DWS_TEST_GITHUB_API_URL);
    const backend = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    if (process.env.DWS_INTEGRATION_TEST !== '1' || !/^dws-test-[a-z0-9]+$/.test(process.env.DWS_TEST_PROJECT ?? '') ||
        !loopback(url) || !loopback(backend) || url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Issue publication is not configured.');
    }
    base = url.origin;
  }
  return { base, token };
}

async function request(path: string, method: 'GET' | 'POST', body: unknown, timeout: number): Promise<{ status: number; value: unknown; retryAt?: string }> {
  const { base, token } = configuration();
  const response = await fetch(`${base}/repos/${ISSUE_REPOSITORY}/issues${path}`, {
    method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, 8_000))),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  // Never retain or log arbitrary GitHub diagnostics, and bound streamed JSON too.
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : NaN;
    const parsed = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : retry ? Date.parse(retry) : reset;
    const retryAt = [403, 429].includes(response.status) && (response.status === 429 || retry || Number.isFinite(reset)) ?
      new Date(Number.isFinite(parsed) && parsed > Date.now() && parsed < 8.64e15 ? parsed : Date.now() + 60_000).toISOString() : undefined;
    await response.body?.cancel(); return { status: response.status, value: null, retryAt };
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid publication response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Invalid publication response.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

function knownIssue(value: unknown): { number: number; url: string } | null {
  if (!value || typeof value !== 'object') return null;
  const issue = value as Record<string, unknown>;
  return Number.isSafeInteger(issue.number) && Number(issue.number) > 0 && !issue.pull_request &&
    issue.html_url === `https://github.com/${ISSUE_REPOSITORY}/issues/${issue.number}` ?
    { number: Number(issue.number), url: issue.html_url as string } : null;
}

export async function publishGithubIssue(payload: IssuePayload, id: string): Promise<GithubOutcome> {
  try { configuration(); } catch { return { status: 'failed', code: 'configuration_required' }; }
  try {
    const result = await request('', 'POST', { title: payload.title, body: formatIssueBody(payload, id),
      labels: ['source:dws-mcp', ISSUE_LABELS[payload.kind]] }, 8_000);
    const issue = result.status === 201 ? knownIssue(result.value) : null;
    if (issue) return { status: 'published', ...issue };
    if ([400, 401, 403, 404, 410, 422, 429].includes(result.status)) {
      return { status: 'failed', code: result.retryAt ? 'rate_limited' : 'github_rejected', ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
    }
  } catch { /* A failed response cannot prove the create was not accepted. */ }
  return { status: 'unknown', code: 'publication_unknown' };
}

export async function reconcileGithubIssue(id: string, createdAt: string): Promise<GithubOutcome> {
  const marker = issueMarker(id);
  // GitHub timestamps have second precision; the database records fractions.
  const since = new Date(Math.floor(new Date(createdAt).getTime() / 1000) * 1000).toISOString();
  const deadline = Date.now() + 25_000;
  try {
    for (let page = 1; page <= 20 && Date.now() < deadline; page++) {
      const query = new URLSearchParams({ state: 'all', since, sort: 'created', direction: 'asc', per_page: '100', page: String(page) });
      const result = await request(`?${query}`, 'GET', undefined, deadline - Date.now());
      if (result.status !== 200 || !Array.isArray(result.value)) break;
      for (const value of result.value) {
        const issue = knownIssue(value);
        if (issue && typeof value.body === 'string' && value.body.split(/\r?\n/).includes(marker)) return { status: 'published', ...issue };
      }
      if (result.value.length < 100) break;
    }
  } catch { /* Unavailable or incomplete reconciliation remains unknown. */ }
  return { status: 'unknown', code: 'publication_unknown' };
}
