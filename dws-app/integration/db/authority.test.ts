import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

const LEDGERS = [
  'dws_action_handoffs', 'migration_batches', 'migration_sources',
  'migration_inventory_chunks', 'migration_items', 'photo_upload_attempts',
  'photo_content_claims', 'photo_action_batches', 'photo_action_items',
  'issue_report_submissions', 'photo_release_state', 'photo_repair_progress',
];

describe('the real database authority boundary (AC-2, AC-8, AC-9, AC-14)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const jobId = randomUUID();
  const activeId = randomUUID();
  const trashId = randomUUID();
  const expiredId = randomUUID();
  const digest = randomUUID().replaceAll('-', '').repeat(2);

  beforeAll(async () => {
    f = await createFixtures();
    const job = await f.admin.from('jobs').insert({ id: jobId, job_number: `authority-${jobId}`, name: 'Authority fixtures' });
    expect(job.error).toBeNull();
    const now = Date.now();
    const rows = [
      { id: activeId, tags: ['visible-test-tag'], content_sha256: null },
      { id: trashId, tags: ['private-trash-metadata'], content_sha256: digest,
        deleted_at: new Date(now - 86_400_000).toISOString(), deleted_by: f.employeeA.id,
        purge_after: new Date(now + 29 * 86_400_000).toISOString() },
      { id: expiredId, tags: ['expired-trash-metadata'], content_sha256: null,
        deleted_at: new Date(now - 31 * 86_400_000).toISOString(), deleted_by: f.employeeA.id,
        purge_after: new Date(now - 86_400_000).toISOString() },
    ].map(row => ({ job_id: jobId, uploader_id: f.employeeA.id, kind: 'image',
      original_path: `originals/${f.employeeA.id}/${row.id}/fixture.jpg`,
      original_name: `${row.id}.jpg`, original_bytes: 4, captured_at: new Date(now).toISOString(), thumb_path: `derived/${f.employeeA.id}/${row.id}_thumb.webp`, ...row }));
    expect((await f.admin.from('photos').insert(rows)).error).toBeNull();
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: false, mcp_enabled: false, repair_enabled: false }).eq('singleton', true)).error).toBeNull();
    const installed = await f.admin.rpc('photo_install_write_boundary', { p_actor: f.administrator.id });
    expect(installed.error).toBeNull();
  });

  afterAll(async () => { await f?.close(); });

  it('denies every inherited table capability on every server-only ledger', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of LEDGERS) {
        const result = await f.sql.query(`select has_table_privilege($1, $2, $3) as allowed`,
          [role, `public.${table}`, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER']);
        expect(result.rows[0].allowed, `${role} must have no ${table} privileges`).toBe(false);
      }
    }
    for (const client of [f.anon, f.employeeA.client, f.employeeB.client, f.administrator.client]) {
      for (const table of LEDGERS) {
        expect((await client.from(table).select('*').limit(1)).error, `${table} SELECT`).not.toBeNull();
        expect((await client.from(table).insert({})).error, `${table} INSERT`).not.toBeNull();
      }
    }
  });

  it('does not expose server-only functions through client RPC credentials', async () => {
    const functions = await f.sql.query(`
      select p.oid::regprocedure::text as signature, r.rolname,
             has_function_privilege(r.oid,p.oid,'EXECUTE') as executable
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join pg_roles r
      where n.nspname='public' and r.rolname in ('anon','authenticated')
        and (p.proname like 'photo\\_%' escape '\\' or p.proname='consume_dws_handoff')`);
    expect(functions.rows.length).toBeGreaterThan(10);
    for (const row of functions.rows) expect(row.executable, `${row.rolname} ${row.signature}`).toBe(false);
    for (const client of [f.anon, f.employeeA.client, f.administrator.client]) {
      const response = await client.rpc('consume_dws_handoff', {
        p_token_digest: '0'.repeat(64), p_actor: f.employeeA.id, p_script: 'remove_photos',
      });
      expect(response.error).not.toBeNull();
    }
  });

  it('old unfiltered employee and administrator SELECT/RPC queries hide all trash metadata', async () => {
    for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
      const direct = await actor.client.from('photos').select('*').eq('job_id', jobId);
      expect(direct.error).toBeNull();
      expect(direct.data?.map(row => row.id)).toEqual([activeId]);
      expect(JSON.stringify(direct.data)).not.toContain('trash-metadata');
      const summaries = await actor.client.rpc('get_photo_job_summaries', { search_query: `authority-${jobId}` });
      expect(summaries.error).toBeNull();
      expect(summaries.data).toHaveLength(1);
      expect(Number(summaries.data?.[0].photo_count)).toBe(1);
      expect(summaries.data?.[0].thumbs).toEqual([`derived/${f.employeeA.id}/${activeId}_thumb.webp`]);
      const tags = await actor.client.rpc('get_photo_tags', { job_filter: jobId, q: null });
      expect(tags.error).toBeNull();
      expect(tags.data).toEqual([{ tag: 'visible-test-tag' }]);
    }
    expect((await f.anon.from('photos').select('*').eq('job_id', jobId)).data ?? []).toEqual([]);
  });

  it('retains deliberate service-role trash, digest, and ownership scopes', async () => {
    const trash = await f.admin.from('photos').select('id').eq('job_id', jobId).not('deleted_at', 'is', null);
    expect(trash.error).toBeNull();
    expect(trash.data?.map(row => row.id).sort()).toEqual([trashId, expiredId].sort());
    const canonical = await f.admin.from('photos').select('id,deleted_at').eq('content_sha256', digest).single();
    expect(canonical.error).toBeNull();
    expect(canonical.data?.id).toBe(trashId);
    expect(canonical.data?.deleted_at).not.toBeNull();
    const owner = await f.admin.from('photos').select('id').eq('original_path', `originals/${f.employeeA.id}/${trashId}/fixture.jpg`);
    expect(owner.error).toBeNull();
    expect(owner.data).toEqual([{ id: trashId }]);
  });

  it('rejects partial trash and legacy-duplicate states even for trusted database writers', async () => {
    const now = Date.now();
    for (const invalid of [
      { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeA.id },
      { purge_after: new Date(now).toISOString() },
      { deleted_at: new Date(now).toISOString(), deleted_by: f.employeeA.id,
        purge_after: new Date(now + 30 * 86_400_000).toISOString(), duplicate_of: activeId },
      { duplicate_of: activeId, legacy_content_sha256: digest },
    ]) {
      const id = randomUUID();
      const inserted = await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeA.id,
        kind: 'image', captured_at: new Date(now).toISOString(), original_path: `originals/${f.employeeA.id}/${id}/invalid.jpg`, ...invalid });
      expect(inserted.error?.code).toBe('23514');
    }
  });

  it('completed action and migration history do not block eventual row purge', async () => {
    const id = randomUUID(); const batchId = randomUUID(); const sourceId = randomUUID(); const itemId = randomUUID(); const actionId = randomUUID();
    const now = Date.now();
    expect((await f.admin.from('migration_batches').insert({ id: batchId, created_by: f.employeeA.id, origin: 'ui', script_name: 'add_photos' })).error).toBeNull();
    expect((await f.admin.from('migration_sources').insert({ id: sourceId, batch_id: batchId, job_id: jobId, kind: 'files', label: 'History fixture' })).error).toBeNull();
    expect((await f.admin.from('migration_items').insert({ id: itemId, source_id: sourceId, relative_path: 'history.jpg', revision: 1,
      scan_id: randomUUID(), source_signature: 'history', original_name: 'history.jpg', original_bytes: 1, mime_type: 'image/jpeg',
      photo_id: id, status: 'pending' })).error).toBeNull();
    expect((await f.admin.from('photos').insert({ id, job_id: jobId, uploader_id: f.employeeA.id, kind: 'image',
      captured_at: new Date(now).toISOString(), original_path: `originals/${f.employeeA.id}/${id}/history.jpg`,
      deleted_at: new Date(now - 31 * 86_400_000).toISOString(), deleted_by: f.employeeA.id,
      purge_after: new Date(now - 86_400_000).toISOString() })).error).toBeNull();
    expect((await f.admin.from('migration_items').update({ status: 'completed', canonical_photo_id: id, canonical_job_id: jobId, result: { status: 'created', photo_id: id, job_id: jobId } }).eq('id', itemId)).error).toBeNull();
    expect((await f.admin.from('photo_action_batches').insert({ id: actionId, created_by: f.employeeA.id, origin: 'ui', action: 'trash' })).error).toBeNull();
    expect((await f.admin.from('photo_action_items').insert({ batch_id: actionId, photo_id: id, expected_job_id: jobId,
      status: 'applied', actor_id: f.employeeA.id, result: { status: 'applied', photo_id: id, action: 'trash' } })).error).toBeNull();
    // This is fixture metadata deletion only; production Storage cleanup and
    // retention claiming remain the repair phase's separate contract.
    expect((await f.admin.from('photos').delete().eq('id', id)).error).toBeNull();
    const item = await f.admin.from('migration_items').select('photo_id,canonical_photo_id,result').eq('id', itemId).single();
    expect(item.data?.photo_id).toBe(id); expect(item.data?.canonical_photo_id).toBeNull();
    expect(item.data?.result.photo_id).toBe(id);
    expect((await f.admin.from('photo_action_items').select('photo_id').eq('batch_id', actionId)).data).toEqual([{ photo_id: id }]);
  });

  it('retained cutover grants deny old hard Delete, null-hash Insert, and authority-column Update', async () => {
    for (const actor of [f.employeeA, f.employeeB, f.administrator]) {
      expect((await actor.client.from('photos').delete().eq('id', activeId)).error).not.toBeNull();
      expect((await actor.client.from('photos').delete().eq('id', trashId)).error).not.toBeNull();
      expect((await actor.client.from('photos').insert({ id: randomUUID(), uploader_id: actor.id,
        job_id: jobId, kind: 'image', original_path: `originals/${actor.id}/bypass.jpg` })).error).not.toBeNull();
      for (const update of [{ job_id: jobId }, { deleted_at: null }, { purge_after: null },
        { deleted_by: actor.id }, { legacy_content_sha256: digest }, { duplicate_of: activeId }]) {
        expect((await actor.client.from('photos').update(update).eq('id', activeId)).error).not.toBeNull();
      }
      const editTrash = await actor.client.from('photos').update({ tags: ['must-not-change'] }).eq('id', trashId).select('id');
      expect(editTrash.error).toBeNull();
      expect(editTrash.data).toEqual([]);
    }
    const pausedEdit = await f.employeeB.client.from('photos').update({ sheet_number: 'A-1' }).eq('id', activeId).select('id');
    expect(pausedEdit.error?.message).toBe('photo_gate_closed');
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true }).eq('singleton', true)).error).toBeNull();
    const editable = await f.employeeB.client.from('photos').update({ sheet_number: 'A-1' }).eq('id', activeId).select('id');
    expect(editable.error).toBeNull();
    expect(editable.data).toEqual([{ id: activeId }]);
    for (const role of ['anon', 'authenticated']) {
      const client = await f.sql.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await expect(client.query('truncate public.photos cascade')).rejects.toMatchObject({ code: '42501' });
      } finally { await client.query('rollback'); client.release(); }
    }
    expect((await f.admin.from('photos').select('id').eq('job_id', jobId)).data).toHaveLength(3);
  });
});
