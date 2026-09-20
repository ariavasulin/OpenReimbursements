import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

describe('serialized issue publication ledger (AC-12, AC-13)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  beforeAll(async () => {
    f = await createFixtures();
    await f.sql.query('update public.photo_release_state set mcp_enabled=true');
  });
  afterAll(async () => { await f?.close(); });
  const digest = () => randomBytes(32).toString('hex');
  const key = () => randomUUID();
  const payload = { title: 'Confirmed title', body: 'Exact body', kind: 'bug', anonymous: false, reporter_name: 'Ari' };
  const claim = (hash: string, clientKey: string | null) => f.admin.rpc('issue_claim_submission', {
    p_payload_digest: hash, p_payload: payload, p_attribution: { reporter_name: 'Ari' }, p_client_key: clientKey,
  });
  const finish = (row: { id: string; lease_generation: number }, status: 'published' | 'failed' | 'unknown', error: unknown = null) =>
    f.admin.rpc('issue_finish_submission', { p_id: row.id, p_generation: row.lease_generation, p_status: status,
      p_github_number: status === 'published' ? 123 : null,
      p_issue_url: status === 'published' ? 'https://github.com/ariavasulin/OpenReimbursements/issues/123' : null, p_error: error });

  it('concurrent different keys coalesce and every key permanently rejects changed payloads', async () => {
    const hash = digest(); const keys = [key(), key(), key()];
    const calls = await Promise.all(keys.map(value => claim(hash, value)));
    expect(calls.every(result => !result.error)).toBe(true);
    expect(new Set(calls.map(result => result.data.id)).size).toBe(1);
    expect(calls.filter(result => result.data.action === 'publish')).toHaveLength(1);
    for (const value of keys) expect((await claim(digest(), value)).error?.message).toBe('conflict');
    const rows = await f.sql.query('select * from public.issue_report_keys where submission_id=$1', [calls[0].data.id]);
    expect(rows.rowCount).toBe(3);
    const publisher = calls.find(result => result.data.action === 'publish')!.data;
    expect((await finish(publisher, 'published')).error).toBeNull();
    expect((await claim(hash, keys[1])).data).toMatchObject({ id: publisher.id, status: 'published', action: 'none' });
  });

  it('unknown beyond24h never republishes; concurrent reconciliation claims serialize', async () => {
    const hash = digest(); const original = (await claim(hash, key())).data;
    expect((await finish(original, 'unknown', { code: 'publication_unknown' })).error).toBeNull();
    await f.sql.query("update public.issue_report_submissions set dedupe_expires_at=now()-interval '1 day',created_at=now()-interval '2 days' where id=$1", [original.id]);
    const results = await Promise.all([claim(hash, key()), claim(hash, key())]);
    expect(results.every(result => !result.error && result.data.id === original.id && result.data.status === 'unknown')).toBe(true);
    expect(results.filter(result => result.data.action === 'reconcile')).toHaveLength(1);
    expect(results.some(result => result.data.action === 'publish')).toBe(false);
    const owner = results.find(result => result.data.action === 'reconcile')!.data;
    expect((await finish(owner, 'failed')).error?.message).toBe('invalid_input');
    expect((await finish(owner, 'published')).error).toBeNull();
    expect((await f.sql.query('select dedupe_expires_at<now() as expired from public.issue_report_submissions where id=$1', [original.id])).rows[0].expired).toBe(true);
  });

  it('expired publishing becomes unknown; stale publisher cannot commit after takeover', async () => {
    const hash = digest(); const original = (await claim(hash, key())).data;
    await f.sql.query("update public.issue_report_submissions set lease_expires_at=now()-interval '1 minute',dedupe_expires_at=now()-interval '1 day' where id=$1", [original.id]);
    const takeover = (await claim(hash, key())).data;
    expect(takeover).toMatchObject({ id: original.id, action: 'reconcile', status: 'unknown', lease_generation: original.lease_generation + 1 });
    expect((await finish(original, 'published')).error?.message).toBe('stale_lease');
    expect((await finish(takeover, 'unknown')).error).toBeNull();
  });

  it('a delayed definitive retry renews dedupe so fresh concurrent keys reuse its successful publication', async () => {
    const hash = digest(); const clientKey = key(); const original = (await claim(hash, clientKey)).data;
    expect((await finish(original, 'failed', { code: 'github_rejected' })).error).toBeNull();
    // Even after24h, the original failed marker remains the sole digest publication candidate.
    // PostgreSQL owns both the renewal clock and this exact comparison; the
    // host and disposable database clocks need not agree to the millisecond.
    const retryStarted = (await f.sql.query("update public.issue_report_submissions set created_at=now()-interval '2 days',dedupe_expires_at=now()-interval '1 day' where id=$1 returning clock_timestamp()::text as started", [original.id])).rows[0].started;
    const retries = await Promise.all([claim(hash, clientKey), claim(hash, key())]);
    expect(retries.every(result => !result.error && result.data.id === original.id)).toBe(true);
    expect(retries.filter(result => result.data.action === 'publish')).toHaveLength(1);
    const owner = retries.find(result => result.data.action === 'publish')!.data;
    expect(owner.lease_generation).toBe(original.lease_generation + 1);
    expect((await finish(owner, 'published')).error).toBeNull();
    const renewal = (await f.sql.query(`select
      dedupe_expires_at >= $2::timestamptz + interval '24 hours' as renewed_for_24h,
      dedupe_expires_at <= clock_timestamp() + interval '24 hours' as bounded_horizon
      from public.issue_report_submissions where id=$1`, [original.id, retryStarted])).rows[0];
    expect(renewal).toEqual({ renewed_for_24h: true, bounded_horizon: true });
    const freshKeys = [key(), key()];
    for (const result of await Promise.all(freshKeys.map(value => claim(hash, value)))) {
      expect(result.error).toBeNull();
      expect(result.data).toMatchObject({ id: original.id, status: 'published', action: 'none' });
    }
    expect((await f.sql.query('select count(*)::int as count from public.issue_report_submissions where payload_digest=$1', [hash])).rows[0].count).toBe(1);
    for (const value of freshKeys) expect((await claim(digest(), value)).error?.message).toBe('conflict');
  });

  it('honors Retry-After before allowing a failed retry', async () => {
    const hash = digest(); const clientKey = key(); const original = (await claim(hash, clientKey)).data;
    expect((await finish(original, 'failed', { code: 'rate_limited', retry_at: new Date(Date.now() + 60_000).toISOString() })).error).toBeNull();
    expect((await claim(hash, clientKey)).data).toMatchObject({ id: original.id, status: 'failed', action: 'none' });
    await f.sql.query("update public.issue_report_submissions set error=jsonb_build_object('code','rate_limited','retry_at',now()-interval '1 second') where id=$1", [original.id]);
    expect((await claim(hash, clientKey)).data).toMatchObject({ id: original.id, action: 'publish' });
  });

  it('known published digests expire after24h but original keys keep their result', async () => {
    const hash = digest(); const clientKey = key(); const original = (await claim(hash, clientKey)).data;
    expect((await finish(original, 'published')).error).toBeNull();
    await f.sql.query("update public.issue_report_submissions set dedupe_expires_at=now()-interval '1 second' where id=$1", [original.id]);
    expect((await claim(hash, clientKey)).data).toMatchObject({ id: original.id, status: 'published', action: 'none' });
    const next = (await claim(hash, key())).data;
    expect(next.id).not.toBe(original.id); expect(next.action).toBe('publish');
  });

  it('blocks clients, invalid publication URLs, and closed-gate claims', async () => {
    for (const actor of [f.anon, f.employeeA.client]) {
      expect((await actor.from('issue_report_keys').select('*')).error).not.toBeNull();
      expect((await actor.rpc('issue_claim_submission', { p_payload_digest: digest(), p_payload: payload, p_attribution: {}, p_client_key: key() })).error).not.toBeNull();
    }
    const original = (await claim(digest(), key())).data;
    expect((await f.admin.rpc('issue_finish_submission', { p_id: original.id, p_generation: original.lease_generation,
      p_status: 'published', p_github_number: 123, p_issue_url: 'https://evil.test/123', p_error: null })).error?.message).toBe('invalid_input');
    await f.sql.query('update public.photo_release_state set mcp_enabled=false');
    try { expect((await claim(digest(), key())).error?.message).toBe('photo_gate_closed'); }
    finally { await f.sql.query('update public.photo_release_state set mcp_enabled=true'); }
  });
});
