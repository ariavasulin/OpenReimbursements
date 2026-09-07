import 'server-only';
import { validateIssueInput, type IssuePayload } from './issues-validation';
import { publishGithubIssue, reconcileGithubIssue } from './issues-github';

export type IssueSubmissionResult = {
  submission_id: string; status: 'pending' | 'publishing' | 'published' | 'failed' | 'unknown'; issue_url?: string;
  error?: { code: string; message: string; retryable: boolean; retry_after?: string };
};

const remedies = {
  configuration_required: 'Ask an administrator to configure the repository Issues credential, then retry this confirmed report.',
  github_rejected: 'Ask an administrator to check the fixed repository, labels, and Issues permission, then retry this confirmed report. Confirm any text correction before submitting it.',
  rate_limited: 'Wait until retry_after, then retry this same confirmed report and idempotency key.',
  publication_unknown: 'Publication is uncertain. Retry this same confirmed report to reconcile its marker; this will not create another issue while the outcome is unknown.',
} as const;

/** Stored and upstream diagnostic text never becomes a public error message. */
export function formatIssueResult(row: { id: string; status: IssueSubmissionResult['status']; issue_url?: string; error?: unknown }): IssueSubmissionResult {
  const result: IssueSubmissionResult = { submission_id: row.id, status: row.status,
    ...(row.status === 'published' ? { issue_url: row.issue_url } : {}) };
  if (row.status === 'failed' || row.status === 'unknown') {
    const stored = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
    const code = row.status === 'unknown' ? 'publication_unknown' :
      ['configuration_required', 'github_rejected', 'rate_limited'].includes(stored.code as string) ? stored.code as keyof typeof remedies : 'github_rejected';
    const retry = stored.retry_at;
    const retryAfter = typeof retry === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(retry) &&
      Number.isFinite(Date.parse(retry)) ? retry : undefined;
    result.error = { code, message: remedies[code], retryable: true,
      ...(code === 'rate_limited' && retryAfter ? { retry_after: retryAfter } : {}) };
  }
  return result;
}

export class IssueSubmissionError extends Error {
  constructor(public readonly code: 'conflict' | 'temporarily_unavailable') {
    super(code === 'conflict' ? 'This idempotency key belongs to a different confirmed report. Use a new key for the changed report.' : 'Issue reporting is temporarily unavailable.');
  }
}

/** No browser identity or session is needed: transport key + MCP gate authorize this narrow operation. */
export async function executeCreateGithubIssue(input: unknown): Promise<IssueSubmissionResult> {
  const { payload, digest, clientKey } = validateIssueInput(input);
  const { supabaseAdmin: db } = await import('@/lib/supabaseAdminClient');
  const claim = await db.rpc('issue_claim_submission', { p_payload_digest: digest, p_payload: payload,
    p_attribution: payload.anonymous ? { anonymous: true } : { anonymous: false, reporter_name: payload.reporter_name }, p_client_key: clientKey });
  if (claim.error) throw new IssueSubmissionError(claim.error.message === 'conflict' ? 'conflict' : 'temporarily_unavailable');
  let row = claim.data;
  if (row.action !== 'none') {
    const outcome = row.action === 'publish' ? await publishGithubIssue(row.payload as IssuePayload, row.id) :
      await reconcileGithubIssue(row.id, row.created_at);
    const saved = await db.rpc('issue_finish_submission', { p_id: row.id, p_generation: row.lease_generation,
      p_status: outcome.status, p_github_number: outcome.status === 'published' ? outcome.number : null,
      p_issue_url: outcome.status === 'published' ? outcome.url : null,
      p_error: outcome.status === 'published' ? null : { code: outcome.code, ...(outcome.retryAt ? { retry_at: outcome.retryAt } : {}) } });
    if (saved.error) throw new IssueSubmissionError('temporarily_unavailable');
    row = saved.data;
  }
  return formatIssueResult(row);
}
