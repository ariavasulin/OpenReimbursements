import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { cleanTags, isSha256 } from '../apiShared';
import { suggestFolderProjects, type SuggestionJob } from '../migration/folders';
import type { PhotoActor } from './authority';
import { photoId, readPhotoBatch } from './reads';
import { PhotoApiError, throwPhotoDatabaseError, photoRpc } from './http';
import { describeAttemptResult } from './uploads';

type Body = Record<string, unknown>;
export function migrationInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new PhotoApiError('invalid_input');
  return value;
}
function string(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new PhotoApiError('invalid_input');
  return value;
}
function path(value: unknown): string {
  const result = string(value, 4096);
  if (result.startsWith('/') || result.includes('\\') || result.split('/').some(part => !part || part === '..' || part === '.') || /[\u0000-\u001f]/.test(result)) throw new PhotoApiError('invalid_input');
  return result;
}
function warnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(w => typeof w !== 'string' || w.length > 256)) throw new PhotoApiError('invalid_input');
  return value;
}
function descriptor(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PhotoApiError('invalid_input');
  const e = value as Body;
  const relative_path = path(e.relative_path), original_name = string(e.original_name, 1024);
  if (original_name !== relative_path.split('/').at(-1)) throw new PhotoApiError('invalid_input');
  return { relative_path, original_name, original_bytes: migrationInteger(e.original_bytes),
    source_mtime: e.source_mtime === null ? null : migrationInteger(e.source_mtime),
    mime_type: string(e.mime_type, 255), source_signature: string(e.source_signature) };
}
export async function ingestMigrationChunk(actor: PhotoActor, source: string, body: Body) {
  if (!Array.isArray(body.entries) || body.entries.length > 500) throw new PhotoApiError('invalid_input');
  const entries = body.entries.map(value => {
    const entry = descriptor(value); const e = value as Body;
    if (e.status !== undefined && !['pending', 'skipped_unsupported'].includes(e.status as string)) throw new PhotoApiError('invalid_input');
    return { ...entry, status: e.status ?? 'pending', warnings: warnings(e.warnings),
      ...(e.sidecar ? { sidecar: descriptor(e.sidecar) } : {}) };
  });
  migrationInteger(entries.reduce((total, entry) => total + Number((entry as Body).original_bytes), 0));
  const serialized = JSON.stringify({ scan_id: body.scan_id, chunk_number: body.chunk_number, entries });
  return photoRpc(actor, 'migration_chunk', { p_actor: actor.actorId, p_source: photoId(source), p_scan: photoId(body.scan_id),
    p_number: migrationInteger(body.chunk_number, 2147483647), p_digest: createHash('sha256').update(serialized).digest('hex'),
    p_encoded: Buffer.byteLength(JSON.stringify(body)), p_entries: entries });
}
export async function saveMigrationSource(actor: PhotoActor, batch: string, body: Body) {
  if (!['directory', 'files'].includes(body.kind as string)) throw new PhotoApiError('invalid_input');
  const rules = body.selection_rules ?? {};
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new PhotoApiError('invalid_input');
  return photoRpc(actor, 'migration_source', { p_actor: actor.actorId, p_batch: photoId(batch), p_source: body.id ? photoId(body.id) : randomUUID(),
    // A source's project is only a default for its folder rows, and may be absent.
    p_job: optionalId(body.job_id), p_kind: body.kind, p_label: string(body.label, 512), p_rules: rules });
}
/** Absent, null, or '' means "none"; anything else must be a UUID. */
function optionalId(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : photoId(value);
}

/** Seal one scan, then pre-fill review for the folder rows that seal just made (AC-17, AC-19). */
export async function sealMigrationSource(actor: PhotoActor, source: string, body: Body) {
  const sealed = await photoRpc(actor, 'migration_seal', { p_actor: actor.actorId, p_source: photoId(source), p_scan: photoId(body.scan_id),
    p_chunks: migrationInteger(body.chunk_count, 2147483647), p_entries: migrationInteger(body.total_entries),
    p_bytes: migrationInteger(body.total_bytes), p_job: optionalId(body.job_id), p_fingerprint: body.fingerprint });
  // The seal has committed and is repeat-safe. Pre-filling is a convenience on top of it: an
  // import with no suggestions is still complete (pressing Start with no edits always works),
  // so a failure here is logged for the operator and never fails the scan.
  try { await prefillMigrationFolders(actor, sealed); }
  catch (error) { console.error('[photo-migrations] folder pre-fill skipped:', error instanceof Error ? error.message : error); }
  return sealed;
}

type SealedSource = { id: string; batch_id: string; job_id: string | null; kind: string; label: string; sealed_scan_id: string | null };
const PREFILL_PAGE = 1000;
/**
 * Suggestions only, and only for rows THIS scan created, so a rescan never brings back
 * something the employee cleared. Nothing is assigned that review does not show.
 *  - Project: the MCP hint arrives as the source's default project and already sits on every
 *    row. Without one, a folder whose name holds an existing project number as a whole word
 *    is suggested that project (suggestFolderProjects walks up through its parents).
 *  - Album name: an MCP `album_name` hint names the album for photos directly inside the
 *    picked folder (or the loose-files selection). Sub-folders keep the names of their paths.
 */
async function prefillMigrationFolders(actor: PhotoActor, source: SealedSource) {
  if (!source.sealed_scan_id) return;
  const batch = await actor.db.from('migration_batches').select('status,origin').eq('id', source.batch_id).maybeSingle();
  if (batch.error) throwPhotoDatabaseError(batch.error);
  if (batch.data?.status !== 'draft') return;

  if (batch.data.origin === 'mcp') {
    const handoff = await actor.db.from('dws_action_handoffs').select('script_name,requested_input')
      .eq('migration_batch_id', source.batch_id).eq('consumed_by', actor.actorId).maybeSingle();
    if (handoff.error) throwPhotoDatabaseError(handoff.error);
    const input = (handoff.data?.requested_input ?? {}) as { album_name?: unknown; sources?: Array<{ label?: unknown; album_name?: unknown }> };
    const hinted = handoff.data?.script_name === 'add_photos' ? input.album_name
      : Array.isArray(input.sources) ? input.sources.find(hint => hint?.label === source.label)?.album_name : undefined;
    if (typeof hinted === 'string' && hinted.trim()) {
      const own = await actor.db.from('migration_folders').select('id').eq('source_id', source.id).eq('folder', '')
        .eq('created_scan_id', source.sealed_scan_id).maybeSingle();
      if (own.error) throwPhotoDatabaseError(own.error);
      if (own.data) await photoRpc(actor, 'migration_folder_update', { p_actor: actor.actorId, p_source: source.id, p_folder: '',
        p_subfolders: false, p_patch: { album_name: hinted.trim().slice(0, 120) } });
    }
  }

  if (source.kind !== 'directory' || source.job_id) return;
  const folders: string[] = [];
  for (let from = 0; ; from += PREFILL_PAGE) {
    const page = await actor.db.from('migration_folders').select('folder').eq('source_id', source.id)
      .eq('created_scan_id', source.sealed_scan_id).is('job_id', null).order('folder').range(from, from + PREFILL_PAGE - 1);
    if (page.error) throwPhotoDatabaseError(page.error);
    folders.push(...(page.data ?? []).map(row => row.folder as string));
    if ((page.data?.length ?? 0) < PREFILL_PAGE) break;
  }
  if (!folders.length) return; // an ordinary rescan: nothing new, so no project list is read at all
  const jobs: SuggestionJob[] = [];
  for (let from = 0; ; from += PREFILL_PAGE) {
    const page = await actor.db.from('jobs').select('id,job_number').eq('is_active', true).order('id').range(from, from + PREFILL_PAGE - 1);
    if (page.error) throwPhotoDatabaseError(page.error);
    jobs.push(...(page.data ?? []) as SuggestionJob[]);
    if ((page.data?.length ?? 0) < PREFILL_PAGE) break;
  }
  const rows = [...suggestFolderProjects(folders, jobs, source.label)].map(([folder, job_id]) => ({ folder, job_id }));
  for (let from = 0; from < rows.length; from += PREFILL_PAGE) {
    await photoRpc(actor, 'migration_folder_suggest', { p_actor: actor.actorId, p_source: source.id, p_scan: source.sealed_scan_id,
      p_rows: rows.slice(from, from + PREFILL_PAGE) });
  }
}

/** Folder rows for review: only folders that still hold photos, in id order for stable paging. */
export async function readMigrationFolders(actor: PhotoActor, id: string, request: Request) {
  await readPhotoBatch(actor, id);
  const params = new URL(request.url).searchParams;
  const raw = params.get('limit');
  const limit = raw === null ? 1000 : migrationInteger(Number(raw), 1000);
  if (limit < 1) throw new PhotoApiError('invalid_input');
  const after = params.get('after') ? photoId(params.get('after')) : null;
  let query = actor.db.from('migration_folders')
    .select('id,source_id,folder,album_name,album_id,job_id,tags,photo_count,jobs(id,job_number,name),albums(id,name),migration_sources!inner(batch_id)')
    .eq('migration_sources.batch_id', id).gt('photo_count', 0).order('id').limit(limit + 1);
  if (after) query = query.gt('id', after);
  const { data, error } = await query;
  if (error) throwPhotoDatabaseError(error);
  const folders = (data ?? []).slice(0, limit).map(({ migration_sources: _source, ...row }) => row);
  return { folders, next_cursor: (data?.length ?? 0) > limit ? folders.at(-1)!.id : null };
}

async function anyRow(actor: PhotoActor, source: string) {
  const { data, error } = await actor.db.from('migration_folders').select('album_name,album_id,job_id,tags,jobs(id,job_number,name),albums(id,name)')
    .eq('source_id', source).order('folder').limit(1).maybeSingle();
  if (error) throwPhotoDatabaseError(error);
  return data;
}
const folderPatchKeys = new Set(['folder', 'include_subfolders', 'job_id', 'tags', 'album_name', 'album_id']);
/** One review edit. `include_subfolders` is how a choice on a top-level folder reaches the folders inside it. */
export async function updateMigrationFolders(actor: PhotoActor, source: string, body: Body) {
  if (Object.keys(body).some(key => !folderPatchKeys.has(key))) throw new PhotoApiError('invalid_input');
  const folder = body.folder;
  if (typeof folder !== 'string' || folder.length > 4096 || (folder !== '' && path(folder) !== folder)) throw new PhotoApiError('invalid_input');
  if (body.include_subfolders !== undefined && typeof body.include_subfolders !== 'boolean') throw new PhotoApiError('invalid_input');
  const patch: Body = {};
  if ('job_id' in body) patch.job_id = optionalId(body.job_id);
  if ('album_id' in body) patch.album_id = optionalId(body.album_id);
  if ('album_name' in body) {
    if (body.album_name !== null && (typeof body.album_name !== 'string' || body.album_name.length > 512)) throw new PhotoApiError('invalid_input');
    patch.album_name = body.album_name;
  }
  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.length > 64 || body.tags.some(tag => typeof tag !== 'string')) throw new PhotoApiError('invalid_input');
    patch.tags = cleanTags(body.tags);
  }
  if (!Object.keys(patch).length) throw new PhotoApiError('invalid_input');
  const deep = body.include_subfolders === true;
  const result = await photoRpc(actor, 'migration_folder_update', { p_actor: actor.actorId, p_source: photoId(source), p_folder: folder,
    p_subfolders: deep, p_patch: patch });
  // The server settles two things the browser cannot know: a blank album name becomes the
  // folder's own name again, and a tag takes the spelling already in use. Every row one edit
  // touches receives the same values, so one row read back speaks for all of them, and the
  // page never has to download thousands of rows again after an edit.
  const readOne = async (inside: boolean) => {
    const query = actor.db.from('migration_folders').select('album_name,album_id,job_id,tags,jobs(id,job_number,name),albums(id,name)').eq('source_id', photoId(source));
    // Two separate filters rather than one or(): a folder name may hold commas or brackets,
    // which are or()'s own grammar. The LIKE pattern escapes LIKE's wildcards.
    const { data, error } = await (inside ? query.like('folder', `${folder.replace(/[\\%_]/g, match => `\\${match}`)}/%`) : query.eq('folder', folder))
      .order('folder').limit(1).maybeSingle();
    if (error) throwPhotoDatabaseError(error);
    return data;
  };
  // The folder's own row if it has one; else, for a whole-folder edit, any row inside it.
  const chosen = await readOne(false) ?? (deep ? folder === '' ? await anyRow(actor, photoId(source)) : await readOne(true) : null);
  return { ...result, settled: chosen ? {
    ...('job_id' in patch ? { job_id: chosen.job_id, jobs: chosen.jobs } : {}),
    ...('tags' in patch ? { tags: chosen.tags } : {}),
    ...('album_name' in patch || 'album_id' in patch ? { album_name: chosen.album_name, album_id: chosen.album_id, albums: chosen.albums } : {}),
  } : {} };
}
export async function readMigrationBatch(actor: PhotoActor, id: string) {
  const summary = await readPhotoBatch(actor, id);
  let requested_input = {};
  if (summary.can_mutate && summary.batch.origin === 'mcp') {
    const handoff = await actor.db.from('dws_action_handoffs').select('requested_input').eq('migration_batch_id', id).eq('consumed_by', actor.actorId).maybeSingle();
    if (handoff.error) throwPhotoDatabaseError(handoff.error);
    requested_input = handoff.data?.requested_input ?? {};
  }
  return { ...summary, batch: { ...summary.batch, requested_input },
    counts: await photoRpc(actor, 'migration_counts', { p_actor: actor.actorId, p_batch: id }) };
}
export function migrationPage(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = params.get('limit');
  const limit = raw === null ? 100 : migrationInteger(Number(raw), 100);
  if (limit < 1) throw new PhotoApiError('invalid_input');
  return { params, limit, after: params.get('after') ? photoId(params.get('after')) : null };
}
export async function readMigrationItems(actor: PhotoActor, id: string, request: Request) {
  await readPhotoBatch(actor, id);
  const { params, limit, after } = migrationPage(request);
  let query = actor.db.from('migration_items').select('*,migration_sources!inner(batch_id,job_id)').eq('migration_sources.batch_id', id).eq('is_current', true).order('id').limit(limit + 1);
  if (after) query = query.gt('id', after);
  if (params.get('source_id')) query = query.eq('source_id', photoId(params.get('source_id')));
  if (params.get('status')) query = query.eq('status', params.get('status')!);
  if (params.get('due') === 'true') query = query.or(`retry_after.is.null,retry_after.lte.${new Date().toISOString()}`);
  const { data, error } = await query;
  if (error) throwPhotoDatabaseError(error);
  const items = (data ?? []).slice(0, limit);
  return { items, next_cursor: (data?.length ?? 0) > limit ? items.at(-1)!.id : null };
}
export class MigrationIdentityChanged extends PhotoApiError { constructor() { super('conflict'); } }
export async function prepareMigrationUpload(actor: PhotoActor, body: Body) {
  if (!isSha256(body.content_sha256)) throw new PhotoApiError('invalid_input');
  const {data: value, error} = await actor.db.rpc('migration_prepare', { p_actor: actor.actorId, p_item: photoId(body.item_id),
    p_revision: migrationInteger(body.revision, 2147483647), p_signature: string(body.source_signature), p_digest: body.content_sha256,
    p_attempt: body.attempt_id ? photoId(body.attempt_id) : null, p_photo: body.photo_id ? photoId(body.photo_id) : null });
  if (error?.message === 'source_changed') throw new MigrationIdentityChanged();
  if (error) throwPhotoDatabaseError(error);
  return { owner_kind: 'migration', owner_id: value.id, photo_id: value.photo_id, job_id: value.job_id,
    content_sha256: value.content_sha256, original_path: value.original_path, thumb_path: value.thumb_path,
    preview_path: value.preview_path, sidecar_path: value.sidecar_path,
    result: value.result ? await describeAttemptResult(actor, value) : null };
}
export async function migrationItemAction(actor: PhotoActor, id: string, body: Body) {
  if (body.action === 'outcome') {
    const retry = body.retry_after ?? null;
    if (retry !== null && (typeof retry !== 'string' || !Number.isFinite(Date.parse(retry)))) throw new PhotoApiError('invalid_input');
    return photoRpc(actor, 'migration_item_outcome', { p_actor: actor.actorId, p_item: photoId(id), p_retry: retry,
      p_generation: migrationInteger(body.lease_generation), p_retryable: typeof body.retryable === 'boolean' ? body.retryable : null, p_fresh: body.new_attempt_required === true,
      p_code: body.error_code ? string(body.error_code, 1024) : null, p_warnings: warnings(body.warnings) });
  }
  return photoRpc(actor, 'migration_item_action', { p_actor: actor.actorId, p_item: photoId(id), p_action: body.action,
    p_fresh: body.new_attempt_required === true });
}
