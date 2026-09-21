import { uploadOne, type UploadDeps, type UploadIdentity, type UploadMeta, type UploadResult } from '../upload';
import type { UploadAttempt } from '../upload-contract';
import { abortUploadWork, UploadRequestError } from '../upload-http';
import type { LocalSource } from './inventory';
import { migrationItemStatusLabel, outcomePayload, retryDue, type BatchView, type ItemPage, type MigrationItem, type MigrationRequest, type MigrationSource } from './client';

export interface MigrationEngineOptions {
  batchId: string; uploaderId: string; sources: MigrationSource[]; localSources: Map<string, LocalSource>;
  request: MigrationRequest; deps: UploadDeps;
  prepare(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<UploadAttempt>;
  meta?: Pick<UploadMeta, 'tags'>;
  onChange(completedItemId?: string): Promise<void>;
  onProgress?(itemId: string, bytes: number, total: number): void;
  onIdentity?(itemId: string, identity: UploadIdentity): void;
}

const runnable = new Set(['pending', 'hashing', 'waiting_claim', 'uploading', 'finalizing', 'retryable_failed']);

/** One foreground pass over durable pages, with at most two open files/hash workers. */
export class MigrationEngine {
  private controller = new AbortController();
  private active = false;
  private updates: Promise<void> = Promise.resolve();
  constructor(private readonly options: MigrationEngineOptions) {}
  stop() { this.controller.abort(); }
  private changed(itemId?: string) {
    this.updates = this.updates.then(() => this.options.onChange(itemId));
    return this.updates;
  }

  async run(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const { request, batchId } = this.options;
    const signal = this.controller.signal;
    try {
      let cursor: string | null = null;
      do {
        signal.throwIfAborted();
        const page: ItemPage = await request(`batches/${batchId}/items?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, undefined, { signal });
        const pending = page.items.filter(item => runnable.has(item.status) && item.retryable !== false && retryDue(item));
        for (let i = 0; i < pending.length; i += 2) {
          signal.throwIfAborted();
          const results = await Promise.allSettled(pending.slice(i, i + 2).map(async item => {
            try {
              const result = await this.upload(item, signal);
              await this.changed(item.id);
              return result;
            }
            catch (error) { this.stop(); throw error; }
          }));
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        }
        cursor = page.next_cursor;
      } while (cursor);
      signal.throwIfAborted();
      const view = await request<BatchView>(`batches/${batchId}`, undefined, { signal });
      const counts = view.counts.by_status as Record<string, number> | undefined;
      const unresolved = Object.entries(counts ?? {}).filter(([status, count]) => count > 0 &&
        !['completed', 'skipped_duplicate', 'skipped_missing', 'skipped_unsupported', 'skipped_failed', 'skipped_user', 'cancelled'].includes(status));
      if (unresolved.length) throw new Error(`Review unfinished files before resuming: ${unresolved.map(([status, count]) => `${count} ${migrationItemStatusLabel(status).toLowerCase()}`).join(', ')}.`);
      // The database alone decides whether every current revision is terminal.
      await request(`batches/${batchId}`, { action: 'complete' }, { method: 'PATCH', signal });
    } finally {
      this.active = false;
      await this.changed();
    }
  }

  async upload(item: MigrationItem, signal: AbortSignal = this.controller.signal): Promise<UploadResult> {
    const { request, prepare, onIdentity } = this.options;
    const source = this.options.sources.find(source => source.id === item.source_id);
    const local = this.options.localSources.get(item.source_id);
    if (!source || !local) throw new Error(`Reselect ${source?.label ?? 'the source folder'} to continue.`);
    let file: File;
    try { file = await abortUploadWork(() => local.getFile(item.relative_path, signal), signal); }
    catch (error) {
      signal.throwIfAborted();
      this.stop();
      throw new Error(`Source access was lost. Reselect ${source.label} and review its scan before resuming. ${error instanceof Error ? error.message : ''}`);
    }
    signal.throwIfAborted();
    const signature = JSON.stringify([file.name, file.size, file.lastModified, item.mime_type]);
    if (signature !== item.source_signature) {
      this.stop();
      throw new Error(`${item.relative_path} changed. Reselect ${source.label} to create a fresh file revision before resuming.`);
    }
    let sidecar: File | undefined;
    if (item.sidecar?.relative_path) {
      try { sidecar = await abortUploadWork(() => local.getFile(item.sidecar!.relative_path, signal), signal); }
      catch { /* Shared uploader records a missing-sidecar warning, preserving the original. */ }
    }
    let currentItem = item;
    let proposedAttemptId: string | undefined;
    let leaseGeneration = item.lease_generation ?? 0;
    let identity: UploadIdentity | undefined = item.content_sha256 ? {
      attemptId: item.upload_attempt_id, photoId: item.photo_id,
      sourceSignature: item.source_signature, contentSha256: item.content_sha256,
    } : undefined;
    const deps: UploadDeps = {
      ...this.options.deps,
      acquireLease: async (owner, options) => {
        const outcome = await this.options.deps.acquireLease(owner, options);
        if (outcome.status === 'acquired') leaseGeneration = outcome.lease_generation;
        return outcome;
      },
      createAttempt: async (input, options) => {
        if (proposedAttemptId && input.attempt_id !== proposedAttemptId) {
          const response = await request<{ item: MigrationItem }>(`items/${currentItem.id}`, { action: 'retry', new_attempt_required: true }, options);
          currentItem = response.item;
        }
        proposedAttemptId = input.attempt_id;
        const attempt = await prepare({ item_id: currentItem.id, revision: currentItem.revision,
          source_signature: input.source_signature, content_sha256: input.content_sha256,
          attempt_id: currentItem.upload_attempt_id, photo_id: currentItem.photo_id }, options);
        identity = { attemptId: currentItem.upload_attempt_id, photoId: attempt.photo_id,
          contentSha256: input.content_sha256, sourceSignature: input.source_signature };
        onIdentity?.(currentItem.id, identity);
        return attempt;
      },
    };
    const result = await uploadOne(file, item.upload_attempt_id, {
      uploaderId: this.options.uploaderId, jobId: source.job_id, ...this.options.meta,
      ...(Array.isArray(source.selection_rules?.tags) ? { tags: source.selection_rules.tags as string[] } : {}),
    }, deps, (bytes, total) => this.options.onProgress?.(item.id, bytes, total), {
      signal, identity, sidecar,
      expectedSidecarName: item.sidecar?.original_name ?? item.sidecar?.name ?? item.sidecar?.relative_path,
      onIdentity: next => { identity = next; onIdentity?.(currentItem.id, next); },
    });
    // Canonical outcomes remain server-owned. This saves only resumable UI details.
    if (!signal.aborted && (result.status === 'failed' || result.status === 'waiting_claim')) {
      try {
        await request(`items/${currentItem.id}`, { ...outcomePayload(result), lease_generation: leaseGeneration }, { signal });
      } catch (reason) {
        if (!(reason instanceof UploadRequestError && reason.status === 409)) throw reason;
        // A rejected generation CAS belongs to a live or more recent worker.
        const error = new Error('Another page owns this file. Pause explicitly or retry after its lease expires.');
        error.name = 'MigrationLeaseUnavailable'; throw error;
      }
    }
    return result;
  }
}
