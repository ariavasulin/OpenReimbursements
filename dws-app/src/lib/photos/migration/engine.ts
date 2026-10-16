import { baseName } from '../classify';
import { fileTypeLabel } from '../file-type';
import { formatTwinMessage, uploadOne, type UploadDeps, type UploadIdentity, type UploadMeta, type UploadResult } from '../upload';
import type { UploadAttempt } from '../upload-contract';
import { abortUploadWork, UploadRequestError } from '../upload-http';
import { createTaskLimiter } from '../task-limiter';
import type { LocalSource } from './inventory';
import { folderOf, type MigrationFolder } from './folders';
import { FORMAT_TWIN_CODE, migrationItemStatusLabel, outcomePayload, retryDue, type BatchView, type ItemPage, type MigrationItem, type MigrationRequest, type MigrationSource } from './client';

export interface MigrationEngineOptions {
  batchId: string; uploaderId: string; sources: MigrationSource[]; localSources: Map<string, LocalSource>;
  /** The reviewed folder rows. Each file uploads under its own folder's project and tags. */
  folders?: MigrationFolder[];
  request: MigrationRequest; deps: UploadDeps;
  prepare(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<UploadAttempt>;
  meta?: Pick<UploadMeta, 'tags'>;
  /** The batch's "Keep other formats" switch. Off: a format twin is left out, never uploaded. */
  keepFormatTwins?: boolean;
  /**
   * A file finished (with its id), or the run ended (no id). The run does not
   * wait for a per-file call, so the page may refresh at its own pace; it
   * awaits the final one.
   */
  onChange(completedItemId?: string): Promise<void>;
  /** The server finished previews for a photo this run imported. */
  onPreviewsMade?(photoId: string): void;
  onProgress?(itemId: string, bytes: number, total: number): void;
  onIdentity?(itemId: string, identity: UploadIdentity): void;
}

const runnable = new Set(['pending', 'hashing', 'waiting_claim', 'uploading', 'finalizing', 'retryable_failed']);

/** One foreground pass over durable pages, with at most two open files/hash workers. */
export class MigrationEngine {
  private controller = new AbortController();
  private active = false;
  private updates: Promise<void> = Promise.resolve();
  private readonly folders = new Map<string, MigrationFolder>();
  /** Server-made previews run beside the import, two at a time. */
  private readonly derives = createTaskLimiter(2);
  constructor(private readonly options: MigrationEngineOptions) {
    for (const row of options.folders ?? []) this.folders.set(`${row.source_id}\n${row.folder}`, row);
  }
  stop() { this.controller.abort(); }
  /**
   * The server takes a file's project and tags from its folder row and refuses a finalize that
   * names a different project, so this must agree with it: the row wins even when its project
   * is empty. Only a file with no row (an import scanned before folder rows existed) falls back
   * to the picked folder's own project.
   */
  private destination(item: MigrationItem, source: MigrationSource): { jobId: string | null; tags: string[] } {
    const row = this.folders.get(`${item.source_id}\n${folderOf(item.relative_path)}`);
    if (row) return { jobId: row.job_id, tags: row.tags };
    const tags = Array.isArray(source.selection_rules?.tags) ? source.selection_rules.tags as string[] : this.options.meta?.tags ?? [];
    return { jobId: source.job_id || null, tags };
  }
  private changed(itemId?: string) {
    const settled = this.updates.then(() => this.options.onChange(itemId));
    // One failed refresh must not swallow every later one.
    this.updates = settled.catch(() => undefined);
    return settled;
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
        const pending = previewableFirst(page.items.filter(item => runnable.has(item.status) && item.retryable !== false && retryDue(item)));
        for (const pair of pairs(pending)) {
          signal.throwIfAborted();
          const results = await Promise.allSettled(pair.map(async item => {
            try {
              const result = await this.upload(item, signal);
              // Not awaited: the next files start while the page refreshes
              // its counts. A failed refresh is only a stale count; the run
              // reads fresh counts itself before it completes the batch.
              void this.changed(item.id).catch(() => undefined);
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
      if (unresolved.length) throw new Error(`Some files still need you before this can finish: ${unresolved.map(([status, count]) => `${count} ${migrationItemStatusLabel(status).toLowerCase()}`).join(', ')}. See the list of files below.`);
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
      // The importer's attempts come from its own prepare step (below), so
      // the ordinary uploads' one-request begin does not apply here.
      begin: undefined,
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
      uploaderId: this.options.uploaderId, ...this.destination(item, source),
    }, deps, (bytes, total) => this.options.onProgress?.(item.id, bytes, total), {
      signal, identity, sidecar, keepFormatTwin: this.options.keepFormatTwins,
      // A slow server preview (a long video, a big TIFF) must not hold up the next file.
      deriveLater: (photoId, derive) => {
        void this.derives.run(derive).then(made => {
          if (made.thumb_path) this.options.onPreviewsMade?.(photoId);
        }).catch(() => undefined);
      },
      expectedSidecarName: item.sidecar?.original_name ?? item.sidecar?.name ?? item.sidecar?.relative_path,
      onIdentity: next => { identity = next; onIdentity?.(currentItem.id, next); },
    });
    // Canonical outcomes remain server-owned. This saves only resumable UI details.
    // A format twin is left out: its reason is saved first, so the list can say why, then the file is
    // skipped. Nothing was claimed, and a skip is final for this import.
    const leftOut = result.status === 'format_twin';
    if (!signal.aborted && (leftOut || result.status === 'failed' || result.status === 'waiting_claim')) {
      try {
        await request(`items/${currentItem.id}`, leftOut
          ? { action: 'outcome', error_code: FORMAT_TWIN_CODE, warnings: [formatTwinMessage(result.twin!)], lease_generation: leaseGeneration }
          : { ...outcomePayload(result), lease_generation: leaseGeneration }, { signal });
        if (leftOut) await request(`items/${currentItem.id}`, { action: 'skip' }, { signal });
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

/**
 * RAW files after everything else (a stable sort), so when a shot's JPEG and RAW are both in the page the
 * JPEG, which gets a preview, is the one imported and the RAW is the one held as its other format.
 */
function previewableFirst(items: MigrationItem[]): MigrationItem[] {
  const raw = (item: MigrationItem) => fileTypeLabel({ kind: 'image', mime_type: null, original_name: item.relative_path }) === 'RAW' ? 1 : 0;
  return [...items].sort((a, b) => raw(a) - raw(b));
}

/**
 * Two files at a time, except that two names differing only in extension in one folder never share a
 * pair: one finishes before the other starts, so the second can be checked as a format twin of the first.
 */
function pairs(items: MigrationItem[]): MigrationItem[][] {
  const shot = (item: MigrationItem) => `${item.source_id}\n${baseName(item.relative_path).toLowerCase()}`;
  const out: MigrationItem[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.length < 2 && shot(last[0]) !== shot(item)) last.push(item);
    else out.push([item]);
  }
  return out;
}

/**
 * Runs `work` at most once per `ms`: the first schedule() starts the clock,
 * later ones inside the window join that same call. cancel() drops a pending
 * call (the caller is about to run `work` itself).
 */
export function createTrailingThrottle(work: () => unknown, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void Promise.resolve().then(work).catch(() => undefined);
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
