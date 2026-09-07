import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PhotoApiError, photoLinkIds } from '@/lib/photos/server/http';
import { assertNoConfiguredSecrets, ConfiguredSecretError } from './secrets';
import { executeCreateGithubIssue, IssueSubmissionError } from './issues';
import { IssueInputError } from './issues-validation';
import { MAX_TAG_LENGTH, MAX_TAGS } from '@/lib/photos/apiShared';

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0);
const job = text(128);
const reference = z.union([
  z.object({ photo_id: z.string().uuid() }).strict(),
  z.object({ photo_url: text(2048) }).strict(),
  z.object({ job_number: job, original_filename: text(512) }).strict(),
]);
const selector = z.union([
  z.object({ photos: z.array(reference).min(1).max(100) }).strict(),
  z.object({ job_number: job, scope: z.enum(['active', 'trash']) }).strict(),
]);
export const scriptSchemas = {
  migrate_photos: z.object({ sources: z.array(z.object({ label: text(255), job_number: job.optional() }).strict()).min(1).max(100).optional() }).strict(),
  add_photos: z.object({ job_number: job.optional(), sheet_number: text(128).optional(), tags: z.array(text(MAX_TAG_LENGTH)).max(MAX_TAGS).optional() }).strict(),
  move_photos: z.object({ selector, destination_job_number: job }).strict(),
  remove_photos: z.object({ selector }).strict(),
  restore_photos: z.object({ selector, destination_job_number: job.optional() }).strict(),
  create_github_issue: z.object({ title: text(200), body: text(16000), kind: z.enum(['bug', 'feature', 'question']), reporter_name: text(200).optional(), anonymous: z.boolean(), confirmed: z.literal(true), idempotency_key: text(200).optional() }).strict(),
};
export const scriptNames = ['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos', 'create_github_issue'] as const;
type ScriptName = typeof scriptNames[number];
const descriptions: Record<ScriptName, string> = {
  migrate_photos: 'Open folder migration in a browser; source labels and job numbers are editable suggestions. Originals upload directly to Storage after login and confirmation.',
  add_photos: 'Open compact file selection with editable job, sheet, and tag suggestions. Uses the same durable upload and recovery workflow.',
  move_photos: 'Open browser review of exact photo targets and a destination job; move only after employee confirmation.',
  remove_photos: 'Open browser review of exact photo targets to move to recoverable 30-day trash. Known public image URLs remain accessible.',
  restore_photos: 'Open browser review of recoverable trash, optionally moving restored photos to a destination job. Expired retention cannot be restored.',
  create_github_issue: 'Publish an explicitly confirmed text report to the fixed OpenReimbursements repository with default reporter attribution or explicit anonymity; retries return the durable submission status.',
};

export function browserOrigin(): string {
  const url = new URL(process.env.DWS_BROWSER_ORIGIN ?? 'https://photos.dws-receipts.com');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new PhotoApiError('temporarily_unavailable');
  }
  assertNoConfiguredSecrets(url.href);
  return url.origin;
}

/** Pure syntax validation only. Photo/job lookup belongs to the logged-in browser. */
export function validateScriptInput(scriptName: ScriptName, input: unknown): Record<string, unknown> {
  assertNoConfiguredSecrets(input);
  const parsed = scriptSchemas[scriptName].safeParse(input);
  if (!parsed.success) throw new PhotoApiError('invalid_input');
  if ('selector' in parsed.data && 'photos' in parsed.data.selector) {
    for (const ref of parsed.data.selector.photos) {
      if (!('photo_url' in ref)) continue;
      let ids: ReturnType<typeof photoLinkIds>;
      try { ids = photoLinkIds(ref.photo_url, browserOrigin()); } catch { throw new PhotoApiError('invalid_input'); }
      if (!z.string().uuid().safeParse(ids.jobId).success ||
          !z.string().uuid().safeParse(ids.photoId).success) throw new PhotoApiError('invalid_input');
    }
  }
  return parsed.data;
}

async function createPhotoHandoff(scriptName: Exclude<ScriptName, 'create_github_issue'>, input: Record<string, unknown>) {
  const token = randomBytes(32).toString('base64url');
  const url = new URL(scriptName === 'migrate_photos' || scriptName === 'add_photos' ? '/migrate' : '/photo-actions', browserOrigin());
  url.searchParams.set('token', token);
  url.searchParams.set('script_name', scriptName);
  const { supabaseAdmin } = await import('@/lib/supabaseAdminClient');
  const { data: expires_at, error } = await supabaseAdmin.rpc('create_dws_handoff', {
    p_token_digest: createHash('sha256').update(token).digest('hex'), p_script_name: scriptName,
    p_requested_input: input,
  });
  if (error || typeof expires_at !== 'string' || !Number.isFinite(Date.parse(expires_at))) throw new PhotoApiError('temporarily_unavailable');
  return { handoff_url: url.href, expires_at };
}

const instructions = {
  photos: `Use migrate_photos for one or more local folders, or add_photos for up to 500 selected files. The hosted assistant cannot read local drives. Gather optional labels/job numbers, then give the employee the returned handoff URL to open in Chrome or Edge. The link expires in 30 minutes and can be consumed once after existing DWS SMS login. The employee selects local files, reviews source-to-job mappings, exclusions, counts and bytes, then confirms before direct browser-to-Supabase uploads. Keep the tab open; reopening and reselecting resumes unfinished work. Jobs and photo references resolve only after login; do not claim a photo exists from a handoff response. move_photos, remove_photos and restore_photos open exact-target browser review and confirmation. Filename ambiguity requires human selection. Removal is recoverable for 30 days, while a known public image URL stays accessible. A valid handoff grants its logged-in consumer broad authority only for its bound action. Never put credentials, the connector URL, attachments, binary data, or code into inputs. Never describe handoff creation as completion of a photo action.`,
  report_issue: `Prepare a concise report about the app, MCP, receipts, photos or workflow. Include what the employee knows: summary, reproduction steps if relevant, expected/actual behavior, impact and supplied context/HTTPS links. Do not demand unknown facts or claim to inspect inaccessible attachments. Ask for the reporter name unless already supplied; anonymity requires an explicit employee request. Show the exact title and body before invoking create_github_issue, including the final "Reported by: <name>" line for non-anonymous reports, and obtain explicit confirmation. Send the body without that server-appended attribution line. Only then set confirmed:true. No SMS/browser session is needed. The server uses fixed repository/labels. Text and already-hosted HTTPS links only: no attachments, base64, local attachment paths, credentials or connector URL. Title maximum 200 characters, body maximum 16,000 characters, whole request maximum 64 KiB. Preserve the confirmed text and reuse the same idempotency_key on retry. Return issue_url only when status is published; unknown means publication is uncertain and retries reconcile without creating another issue; do not change the body or key to bypass reconciliation. For failed submissions, an administrator can check the configured Issues credential, repository permissions and labels; wait out rate limits and retry the unchanged confirmed input and key. A corrected payload needs fresh confirmation. This tool cannot diagnose the repository, edit/close issues, inspect code, or launch an agent.`,
};
const jsonScriptSchemas = Object.fromEntries(scriptNames.map(name => [name, zodToJsonSchema(scriptSchemas[name])]));
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
function businessError(error: unknown) {
  const code = error instanceof PhotoApiError || error instanceof IssueSubmissionError ? error.code
    : error instanceof IssueInputError || error instanceof ConfiguredSecretError ? 'invalid_input' : 'temporarily_unavailable';
  const message = error instanceof IssueSubmissionError ? error.message
    : code === 'temporarily_unavailable' ? 'DWS operations are temporarily unavailable.' : 'Invalid request.';
  return { ...result({ error: { code, message, retryable: code === 'temporarily_unavailable' } }), isError: true };
}

/** Each HTTP request gets a new server and transport; durable workflow state lives in Postgres. */
export function createDwsMcpServer(): McpServer {
  const server = new McpServer({ name: 'dws', version: '1.0.0' });
  server.registerTool('load_dws_skill', {
    description: 'Load DWS photos (migrate, add, move, remove, restore) or report_issue (confirmed issue publication) instructions and script schemas.',
    inputSchema: { skill_name: z.enum(['photos', 'report_issue']) },
    annotations: { readOnlyHint: true },
  }, async ({ skill_name }) => result({ skill_name, instructions: instructions[skill_name], scripts: scriptNames
    .filter(name => skill_name === 'photos' ? name !== 'create_github_issue' : name === 'create_github_issue')
    .map(name => ({ script_name: name, description: descriptions[name], input_schema: jsonScriptSchemas[name] })) }));
  server.registerTool('execute_dws_script', {
    description: scriptNames.map(name => `${name}: ${descriptions[name]}`).join('\n') + '\nLoad the relevant skill for exact per-script input schemas before calling.',
    inputSchema: { script_name: z.enum(scriptNames), input: z.record(z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ script_name, input }) => {
    try {
      const validated = validateScriptInput(script_name, input);
      return result(script_name === 'create_github_issue'
        ? await executeCreateGithubIssue(validated)
        : await createPhotoHandoff(script_name, validated));
    } catch (error) { return businessError(error); }
  });
  return server;
}
