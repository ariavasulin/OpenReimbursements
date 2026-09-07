import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

describe('transactional handoff authority (AC-2, AC-8)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true, mcp_enabled: true }).eq('singleton', true)).error).toBeNull();
  });
  afterAll(async () => { await f?.close(); });

  async function handoff(script = 'migrate_photos', expired = false) {
    const id = randomUUID();
    const digest = randomBytes(32).toString('hex');
    expect((await f.admin.from('dws_action_handoffs').insert({ id, token_digest: digest,
      script_name: script, requested_input: {}, expires_at: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString() })).error).toBeNull();
    return { id, digest };
  }

  it('serializes simultaneous consumes to exactly one durable actor/batch binding', async () => {
    const token = await handoff();
    const outcomes = await Promise.all([f.employeeA, f.employeeB].map(actor =>
      f.admin.rpc('consume_dws_handoff', { p_token_digest: token.digest, p_actor: actor.id, p_script: 'migrate_photos' })));
    expect(outcomes.filter(result => !result.error)).toHaveLength(1);
    expect(outcomes.filter(result => result.error)).toHaveLength(1);
    const saved = await f.admin.from('dws_action_handoffs').select('*').eq('id', token.id).single();
    expect(saved.error).toBeNull();
    expect(saved.data?.consumed_at).not.toBeNull();
    expect(saved.data?.migration_batch_id).not.toBeNull();
    expect(saved.data?.photo_action_batch_id).toBeNull();
    const batch = await f.admin.from('migration_batches').select('*').eq('id', saved.data!.migration_batch_id).single();
    expect(batch.error).toBeNull();
    expect(batch.data?.created_by).toBe(saved.data?.consumed_by);
    expect(batch.data?.script_name).toBe('migrate_photos');
    const before = await f.admin.from('migration_batches').select('id', { count: 'exact' });
    expect((await f.admin.rpc('consume_dws_handoff', { p_token_digest: token.digest,
      p_actor: saved.data!.consumed_by, p_script: 'migrate_photos' })).error).not.toBeNull();
    const after = await f.admin.from('migration_batches').select('id', { count: 'exact' });
    expect(after.count).toBe(before.count);
  });

  it('expired tokens and a mismatched script leave the token unconsumed', async () => {
    const expired = await handoff('add_photos', true);
    const mismatch = await handoff('remove_photos');
    for (const [token, script] of [[expired, 'add_photos'], [mismatch, 'restore_photos']] as const) {
      const result = await f.admin.rpc('consume_dws_handoff', { p_token_digest: token.digest,
        p_actor: f.employeeA.id, p_script: script });
      expect(result.error).not.toBeNull();
      const row = await f.admin.from('dws_action_handoffs').select('consumed_at,migration_batch_id,photo_action_batch_id').eq('id', token.id).single();
      expect(row.data).toEqual({ consumed_at: null, migration_batch_id: null, photo_action_batch_id: null });
    }
  });

  it('another employee cannot mutate a known migration batch ID', async () => {
    const token = await handoff();
    expect((await f.admin.rpc('consume_dws_handoff', { p_token_digest: token.digest,
      p_actor: f.employeeA.id, p_script: 'migrate_photos' })).error).toBeNull();
    const row = await f.admin.from('dws_action_handoffs').select('migration_batch_id').eq('id', token.id).single();
    const forbidden = await f.admin.rpc('photo_cancel_migration', { p_actor: f.employeeB.id, p_batch_id: row.data!.migration_batch_id });
    expect(forbidden.error).not.toBeNull();
    const saved = await f.admin.from('migration_batches').select('status').eq('id', row.data!.migration_batch_id).single();
    expect(saved.data?.status).toBe('draft');
  });

  it('cannot grant broad removal from a UI-origin action or an unbound MCP batch', async () => {
    const jobId = randomUUID(); const photoId = randomUUID();
    expect((await f.admin.from('jobs').insert({ id: jobId, job_number: `handoff-${jobId}`, name: 'Handoff fixture' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id: photoId, job_id: jobId, uploader_id: f.employeeB.id,
      kind: 'image', captured_at: new Date().toISOString(), original_path: `originals/${f.employeeB.id}/${photoId}/file.jpg` })).error).toBeNull();
    for (const origin of ['ui', 'mcp']) {
      const batchId = randomUUID();
      const inserted = await f.admin.from('photo_action_batches').insert({ id: batchId, created_by: f.employeeA.id,
        origin, action: 'trash', selector: { photos: [{ photo_id: photoId }] } });
      if (inserted.error) {
        // A schema check that prohibits this origin/action pair is equally
        // authoritative; it must fail with a constraint, not a transport error.
        expect(inserted.error.code).toBe('23514');
        continue;
      }
      expect((await f.admin.from('photo_action_items').insert({ batch_id: batchId, photo_id: photoId, expected_job_id: jobId })).error).toBeNull();
      const approved = await f.admin.rpc('photo_approve_action', { p_actor: f.employeeA.id, p_batch_id: batchId });
      if (!approved.error) {
        const applied = await f.admin.rpc('photo_apply_action', { p_actor: f.employeeA.id, p_batch_id: batchId, p_photo_id: photoId });
        expect(applied.error || applied.data?.status === 'conflict').toBeTruthy();
      }
      const saved = await f.admin.from('photos').select('deleted_at').eq('id', photoId).single();
      expect(saved.data?.deleted_at).toBeNull();
    }
  });
});
