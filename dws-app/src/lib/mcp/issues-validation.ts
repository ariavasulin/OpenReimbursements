import { createHash } from 'node:crypto';
import { assertNoConfiguredSecrets } from './secrets';

export const ISSUE_REPOSITORY = 'ariavasulin/OpenReimbursements';
export const ISSUE_LABELS = { bug: 'bug', feature: 'enhancement', question: 'question' } as const;
export type IssuePayload = { title: string; body: string; kind: keyof typeof ISSUE_LABELS; anonymous: boolean; reporter_name?: string };
export class IssueInputError extends Error {
  readonly code = 'invalid_input';
  constructor() { super('Provide a confirmed text report with a name or explicit anonymity. Attachments, secrets, and target overrides are not accepted.'); }
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/** Only digest serialization normalizes text; publication preserves confirmed text. */
function normalized(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[\t ]+$/g, '')).join('\n').trim();
}

function validateLinks(value: string): void {
  const secure = (reference: string) => {
    try {
      const url = new URL(reference);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error();
    } catch { throw new IssueInputError(); }
  };
  // Validate recognizable link destinations, preserving ordinary prose such as "Metadata:".
  for (const link of value.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) secure(link[1] ?? link[2]);
  for (const link of value.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm)) secure(link[1] ?? link[2]);
  for (const link of value.matchAll(/<([A-Za-z][A-Za-z0-9+.-]*:[^>]+)>/g)) secure(link[1]);
  for (const link of value.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>\])]+/g)) secure(link[0]);
  // A colon label alone is prose. URI attachments have a scheme payload;
  // data URIs additionally require their comma separator.
  if (/\b(?:javascript|vbscript|file|blob|ftp|ftps|mailto|http):(?=\S)|\bdata:[^\s,]*,/i.test(value)) throw new IssueInputError();
}

function attachmentOnlyPath(body: string): boolean {
  return body.split(/\r?\n/).map(line => line.trim()).filter(Boolean).every(line => {
    const value = line.replace(/^(?:attach(?:ment)?\s*:?\s+)/i, '');
    const quoted = /^(["'`])([^\r\n]+)\1$/.exec(value);
    const path = quoted?.[2] ?? value;
    return /^(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/i.test(path);
  });
}

export function validateIssueInput(input: unknown): { payload: IssuePayload; digest: string; clientKey: string | null } {
  assertNoConfiguredSecrets(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IssueInputError();
  const data = input as Record<string, unknown>;
  const fields = ['title', 'body', 'kind', 'reporter_name', 'anonymous', 'confirmed', 'idempotency_key'];
  if (Object.keys(data).some(key => !fields.includes(key)) || data.confirmed !== true || typeof data.anonymous !== 'boolean' ||
      !text(data.title, 200) || /[\r\n]/.test(data.title) || !text(data.body, 16_000) ||
      typeof data.kind !== 'string' || !Object.hasOwn(ISSUE_LABELS, data.kind)) throw new IssueInputError();
  if ((!data.anonymous && !text(data.reporter_name, 200)) ||
      (data.reporter_name !== undefined && (!text(data.reporter_name, 200) || /[\r\n]/.test(data.reporter_name)))) throw new IssueInputError();
  if (data.idempotency_key !== undefined && (typeof data.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(data.idempotency_key))) throw new IssueInputError();
  // Reserved markers could otherwise impersonate another submission during reconciliation.
  // Links are references only; this module never fetches caller-controlled URLs.
  for (const value of [data.title, data.body, data.reporter_name ?? ''] as string[]) {
    validateLinks(value);
    if (/<!--\s*dws-submission\s*:[\s\S]*?-->/i.test(value) ||
        /[A-Za-z0-9+/]{256,}={0,2}/.test(value)) throw new IssueInputError();
  }
  if (attachmentOnlyPath(data.body)) throw new IssueInputError();
  const payload: IssuePayload = { title: data.title, body: data.body, kind: data.kind as IssuePayload['kind'], anonymous: data.anonymous,
    ...(!data.anonymous ? { reporter_name: data.reporter_name as string } : {}) };
  const canonical = { repository: ISSUE_REPOSITORY, title: normalized(payload.title), body: normalized(payload.body),
    kind: payload.kind, anonymous: payload.anonymous, reporter_name: payload.anonymous ? null : normalized(payload.reporter_name!) };
  return { payload, digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'), clientKey: data.idempotency_key as string | undefined ?? null };
}

export function issueMarker(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new IssueInputError();
  return `<!-- dws-submission:${id} -->`;
}

export function formatIssueBody(payload: IssuePayload, id: string): string {
  return `${payload.body}${payload.anonymous ? '' : `\n\nReported by: ${payload.reporter_name}`}\n\n${issueMarker(id)}`;
}
