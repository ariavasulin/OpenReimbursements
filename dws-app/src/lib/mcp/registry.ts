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
import { harnessInstructions, skillDiscovery, skillNames, skills, type SkillName } from './harness';

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
  migrate_photos: z.object({ sources: z.array(z.object({ label: text(255), job_number: job.optional(), new_project_name: text(120).optional() }).strict()).min(1).max(100).optional() }).strict(),
  add_photos: z.object({ job_number: job.optional(), new_project_name: text(120).optional(), tags: z.array(text(MAX_TAG_LENGTH)).max(MAX_TAGS).optional() }).strict(),
  move_photos: z.object({ selector, destination_job_number: job }).strict(),
  remove_photos: z.object({ selector }).strict(),
  restore_photos: z.object({ selector, destination_job_number: job.optional() }).strict(),
  create_github_issue: z.object({ title: text(200), body: text(16000), kind: z.enum(['bug', 'feature', 'question']), reporter_name: text(200).optional(), anonymous: z.boolean(), confirmed: z.literal(true), idempotency_key: text(200).optional() }).strict(),
};
export const scriptNames = ['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos', 'create_github_issue'] as const;
type ScriptName = typeof scriptNames[number];
const descriptions: Record<ScriptName, string> = {
  migrate_photos: 'Open folder migration in a browser; source labels, job numbers, and new project names are editable suggestions. Originals upload directly to Storage after login and confirmation.',
  add_photos: 'Open compact file selection with editable job, new project name, and tag suggestions. Uses the same durable upload and recovery workflow.',
  move_photos: 'Open browser review of exact photo targets and a destination job; move only after employee confirmation.',
  remove_photos: 'Open browser review of exact photo targets to move to recoverable 30-day trash. Known public image URLs remain accessible.',
  restore_photos: 'Open browser review of recoverable trash, optionally moving restored photos to a destination job. Expired retention cannot be restored.',
  create_github_issue: 'Publish a feature, bug, or question after the report_issue interview and explicit permission to post the displayed final title, body, and attribution. Never call during brainstorming or draft review. Uses the fixed OpenReimbursements repository with default reporter attribution or explicit anonymity; unchanged confirmed retries return the durable submission status.',
};

export function browserOrigin(): string {
  const url = new URL(process.env.DWS_BROWSER_ORIGIN ?? 'https://photos.design-workshops.app');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new PhotoApiError('temporarily_unavailable');
  }
  assertNoConfiguredSecrets(url.href);
  return url.origin;
}

/** Pure syntax validation only. Photo/job lookup belongs to the logged-in browser. */
function assertScriptName(name: string): asserts name is ScriptName {
  if (!Object.prototype.hasOwnProperty.call(scriptSchemas, name)) throw new PhotoApiError('invalid_input');
}

export function validateScriptInput(scriptName: string, input: unknown): Record<string, unknown> {
  assertScriptName(scriptName);
  assertNoConfiguredSecrets(input);
  const parsed = scriptSchemas[scriptName].safeParse(input);
  if (!parsed.success) throw new PhotoApiError('invalid_input');
  if ('selector' in parsed.data && 'photos' in parsed.data.selector) {
    for (const ref of parsed.data.selector.photos) {
      if (!('photo_url' in ref)) continue;
      let ids: ReturnType<typeof photoLinkIds>;
      try { ids = photoLinkIds(ref.photo_url, browserOrigin()); } catch { throw new PhotoApiError('invalid_input'); }
      // `/photos?photo=<id>` names no project. An older `/photos/<jobId>?photo=<id>` link
      // must still carry a UUID there, and the photo id is a UUID in both shapes.
      if ((ids.jobId !== null && !z.string().uuid().safeParse(ids.jobId).success) ||
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

const skillScripts = {
  photos: ['migrate_photos', 'add_photos', 'move_photos', 'remove_photos', 'restore_photos'],
  report_issue: ['create_github_issue'],
} as const satisfies Record<SkillName, readonly ScriptName[]>;
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
  const server = new McpServer({ name: 'dws', version: '1.0.0' }, { instructions: harnessInstructions });
  server.registerTool('load_dws_skill', {
    description: skillDiscovery,
    inputSchema: { skill_name: z.enum(skillNames) },
    annotations: { readOnlyHint: true },
  }, async ({ skill_name }) => result({ skill_name, instructions: skills[skill_name].instructions, harness_instructions: harnessInstructions, scripts: skillScripts[skill_name]
    .map(name => ({ script_name: name, description: descriptions[name], input_schema: jsonScriptSchemas[name] })) }));
  server.registerTool('execute_dws_script', {
    description: 'Execute a DWS script described by a loaded skill. Load the relevant skill first, follow its workflow and confirmation requirements, and pass the script name and input matching its argument schema.',
    inputSchema: { script_name: z.string().min(1).max(64), input: z.record(z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ script_name, input }) => {
    try {
      assertScriptName(script_name);
      const validated = validateScriptInput(script_name, input);
      return result(script_name === 'create_github_issue'
        ? await executeCreateGithubIssue(validated)
        : await createPhotoHandoff(script_name, validated));
    } catch (error) { return businessError(error); }
  });
  return server;
}
