import { inventoryChunks, type LocalSource } from './inventory';
import type { MigrationRequest, MigrationSource } from './client';

/** Register, stream, and seal one selected source under its reviewed mapping. */
export async function scanMigrationSource(request: MigrationRequest, options: {
  batchId: string; source: MigrationSource; local: LocalSource;
  register: boolean; selectionRules: { tags: string[] };
  signal: AbortSignal; onChunk(chunkCount: number): void;
}): Promise<void> {
  const { batchId, source, local, signal } = options;
  if (options.register) {
    await request(`batches/${batchId}/sources`, { id: source.id, job_id: source.job_id, kind: source.kind,
      label: source.label, selection_rules: options.selectionRules }, { signal });
  }
  const scanId = crypto.randomUUID();
  await request(`sources/${source.id}/scan`, { scan_id: scanId }, { signal });
  let chunkNumber = 0, totalEntries = 0, totalBytes = 0;
  const digests: string[] = [];
  for await (const entries of inventoryChunks(local.entries(signal), (entries, chunk_number) => ({ scan_id: scanId, chunk_number, entries }))) {
    const chunk = await request<{ payload_digest: string; entry_count: number; total_bytes: number }>(`sources/${source.id}/chunks`,
      { scan_id: scanId, chunk_number: chunkNumber++, entries }, { signal });
    digests.push(chunk.payload_digest); totalEntries += chunk.entry_count; totalBytes += chunk.total_bytes;
    options.onChunk(chunkNumber);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digests.join('')));
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  await request(`sources/${source.id}/seal`, { scan_id: scanId, chunk_count: chunkNumber,
    total_entries: totalEntries, total_bytes: totalBytes, job_id: source.job_id, fingerprint }, { signal });
}
