import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { isSha256 } from '../apiShared';
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
    p_job: photoId(body.job_id), p_kind: body.kind, p_label: string(body.label, 512), p_rules: rules });
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
