import { createUploadRetryPolicy, UploadRequestError } from '../upload-http';
import type { UploadResult } from '../upload';
import type { MigrationFolder } from './folders';

/** What the assistant suggested for one picked folder. Every field is only a suggestion. */
export interface MigrationSourceHint { label: string; job_number?: string; new_project_name?: string; album_name?: string; tags?: string[] }
export interface MigrationBatch {
  id: string; status: string; script_name: 'migrate_photos' | 'add_photos';
  /** The picked folders' names, for listing an earlier import by folder and date. */
  labels?: string[];
  requested_input?: { job_number?: string; new_project_name?: string; album_name?: string; tags?: string[]; sources?: MigrationSourceHint[] };
  created_at?: string;
}
export interface MigrationSource {
  /** Only a default for this picked folder's rows; each folder row carries its own project. */
  id: string; batch_id: string; job_id: string | null; kind: 'directory' | 'files'; label: string;
  current_scan_id?: string | null; sealed_scan_id?: string | null;
  scan_id?: string | null; sealed_at?: string | null;
  jobs?: { id: string; job_number: string; name: string } | null;
  scan_status?: string; selection_rules?: Record<string, unknown>;
}
export interface MigrationItem {
  id: string; source_id: string; relative_path: string; original_name: string; original_bytes: number;
  source_mtime: number; mime_type: string; source_signature: string; revision: number;
  photo_id: string; upload_attempt_id: string; content_sha256: string | null; status: string;
  canonical_photo_id?: string | null; canonical_job_id?: string | null;
  sidecar?: { relative_path: string; original_name?: string; name?: string } | null;
  result?: Record<string, unknown> | null; warnings?: string[]; error_code?: string | null;
  error?: { code?: string; message?: string } | null;
  retry_after?: string | null; lease_expires_at?: string | null;
  retryable?: boolean | null; new_attempt_required?: boolean;
  lease_generation?: number;
}
export interface ItemPage { items: MigrationItem[]; next_cursor: string | null }
export interface BatchView {
  batch: MigrationBatch; can_mutate: boolean;
  counts: Record<string, number | Record<string, number>>;
}
export type MigrationRequest = <T>(path: string, body?: unknown, options?: { method?: string; signal?: AbortSignal }) => Promise<T>;

/** Bounded, cookie-authenticated control requests; originals never enter this API. */
export function createMigrationRequest(refreshAuth: () => Promise<boolean>, fetchRequest: typeof fetch = fetch): MigrationRequest {
  return async <T>(path: string, body?: unknown, options: { method?: string; signal?: AbortSignal } = {}): Promise<T> => {
    const retry = createUploadRetryPolicy({ refreshAuth });
    options.signal?.throwIfAborted();
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetchRequest(`/api/photo-migrations/${path}`, {
          method: options.method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: encodedBody, signal: options.signal, cache: 'no-store',
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        await retry(attempt, new UploadRequestError('Connection interrupted. Retry when connected.', { code: 'network_error', retryable: true }), undefined, options.signal);
        continue;
      }
      const payload = await response.json();
      if (response.ok) return payload as T;
      const failure = new UploadRequestError(payload.error?.message ?? `Migration request failed (${response.status})`, {
        code: payload.error?.code ?? 'migration_failed', status: response.status, retryable: response.status === 429 || response.status >= 500,
      });
      await retry(attempt, failure, response.headers.get('Retry-After'), options.signal);
    }
  };
}

/** Per-file progress needs counts/items; source mappings change at batch boundaries. */
export async function loadMigrationBatch(request: MigrationRequest, id: string, options: {
  after?: string | null; includeSources?: boolean;
} = {}) {
  const [view, items, sources] = await Promise.all([
    request<BatchView>(`batches/${id}`),
    request<ItemPage>(`batches/${id}/items?limit=50${options.after ? `&after=${encodeURIComponent(options.after)}` : ''}`),
    options.includeSources === false ? undefined : (async () => {
      const all: MigrationSource[] = []; let cursor: string | null = null;
      do {
        const page: { sources: MigrationSource[]; next_cursor: string | null } = await request(`batches/${id}/sources?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
        all.push(...page.sources); cursor = page.next_cursor;
      } while (cursor);
      return all;
    })(),
  ]);
  return { view, items, sources };
}

/**
 * Every folder row of one import, 500 per request. It stops on an EMPTY page, never on a short
 * one: the API caps how many rows one response may hold, so a short page does not mean the end.
 * (Stopping early once hid 4,000 of 5,000 folders.) The guard bounds a misbehaving server.
 */
export async function loadMigrationFolders(request: MigrationRequest, id: string, options: { signal?: AbortSignal } = {}): Promise<MigrationFolder[]> {
  const all: MigrationFolder[] = []; let cursor: string | null = null;
  for (let pages = 0; pages < 10_000; pages++) {
    const page: { folders: MigrationFolder[]; next_cursor: string | null } = await request(
      `batches/${id}/folders?limit=500${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, undefined, options);
    if (!page.folders.length) break;
    all.push(...page.folders);
    cursor = page.next_cursor ?? page.folders.at(-1)!.id;
  }
  return all;
}

export function retryDue(item: MigrationItem, now = Date.now()): boolean {
  const retryAt = item.retry_after ? Date.parse(item.retry_after) : Number(item.result?.retryAt ?? 0);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

/** What one file's state means, in the words an employee would use. No internal status reaches the screen. */
const ITEM_STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting', hashing: 'Checking', waiting_claim: 'Waiting for another upload', uploading: 'Uploading', finalizing: 'Finishing',
  completed: 'Imported', skipped_duplicate: 'Already in DWS Photos', retryable_failed: 'Upload failed',
  job_conflict: 'In another project', restore_required: 'In trash',
  skipped_missing: 'No longer in the folder', skipped_unsupported: 'Left out', skipped_failed: 'Could not be imported',
  skipped_user: 'Skipped', cancelled: 'Cancelled',
};
export function migrationItemStatusLabel(status: string): string {
  return ITEM_STATUS_LABELS[status] ?? 'Waiting';
}

/** The whole import's state in plain words. `attention` wins: something needs the employee. */
export function migrationBatchStatusLabel(status: string, attention = false): string {
  if (attention) return 'Needs attention';
  return ({ draft: 'Not started', approved: 'Importing', running: 'Importing', interrupted: 'Paused',
    completed: 'Finished', cancelled: 'Cancelled' } as Record<string, string>)[status] ?? 'Not started';
}

/** Why a file was left out, from the scan's reason codes. */
const EXCLUSION_LABELS: Record<string, string> = {
  picasa_originals: 'Picasa backup copies', picasa_settings: 'Picasa settings files', hidden_cache: 'Hidden and system files',
  unmatched_xmp: 'XMP files with no matching photo', ambiguous_xmp: 'XMP files that match more than one photo',
  unsupported_file: 'Files that are not photos or videos', unsupported: 'Files that are not photos or videos',
};
export function migrationExclusionLabel(reason: string): string {
  return EXCLUSION_LABELS[reason] ?? 'Other files';
}

/** "Smith Residence, Marketing and 2 more · Sep 20, 2026": an earlier import named by folder and date, never by id. */
export function migrationBatchName(batch: { script_name: string; created_at?: string; labels?: string[] }, locale?: string): string {
  const labels = (batch.labels ?? []).filter(Boolean);
  const shown = labels.slice(0, 2).join(', ');
  const what = !labels.length ? (batch.script_name === 'add_photos' ? 'Added photos' : 'Folder import')
    : labels.length > 2 ? `${shown} and ${labels.length - 2} more` : shown;
  const when = batch.created_at && Number.isFinite(Date.parse(batch.created_at))
    ? new Date(batch.created_at).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return when ? `${what} · ${when}` : what;
}

/** Transport abort releases a resumable lease with no recorded failure.
 * A persisted outcome remains a failure even when its batch is later paused.
 */
export function isPausedMigrationItem(item: MigrationItem, batchStatus: string): boolean {
  return batchStatus === 'interrupted' &&
    ['pending', 'hashing', 'waiting_claim', 'uploading', 'finalizing', 'retryable_failed'].includes(item.status) &&
    item.error == null && !item.error_code && item.retryable == null &&
    !item.new_attempt_required && !item.retry_after;
}

export function outcomePayload(result: UploadResult) {
  return { action: 'outcome', retry_after: result.retryAt ? new Date(result.retryAt).toISOString() : null,
    error_code: result.error ?? null, warnings: result.warnings,
    retryable: result.retryable ?? null, new_attempt_required: result.newAttemptRequired ?? false };
}
