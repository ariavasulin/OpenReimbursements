import { createUploadRetryPolicy, UploadRequestError } from '../upload-http';
import type { UploadResult } from '../upload';

export interface MigrationBatch {
  id: string; status: string; script_name: 'migrate_photos' | 'add_photos';
  requested_input?: { job_number?: string; sheet_number?: string; tags?: string[]; sources?: { label: string; job_number?: string }[] };
  created_at?: string;
}
export interface MigrationSource {
  id: string; batch_id: string; job_id: string; kind: 'directory' | 'files'; label: string;
  current_scan_id?: string | null; sealed_scan_id?: string | null;
  scan_id?: string | null; sealed_at?: string | null;
  jobs?: { id: string; job_number: string; name: string } | null;
  scan_status?: string; selection_rules?: Record<string, unknown>;
}
export interface MigrationItem {
  id: string; source_id: string; relative_path: string; original_name: string; original_bytes: number;
  source_mtime: number; mime_type: string; source_signature: string; revision: number;
  photo_id: string; upload_attempt_id: string; content_sha256: string | null; status: string;
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
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetchRequest(`/api/photo-migrations/${path}`, {
          method: options.method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal, cache: 'no-store',
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

export function retryDue(item: MigrationItem, now = Date.now()): boolean {
  const retryAt = item.retry_after ? Date.parse(item.retry_after) : Number(item.result?.retryAt ?? 0);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

export function migrationItemStatusLabel(status: string): string {
  return status === 'retryable_failed' ? 'Upload failed' : status.replaceAll('_', ' ');
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
