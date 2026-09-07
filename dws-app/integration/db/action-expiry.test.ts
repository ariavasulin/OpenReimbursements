import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

let f: Awaited<ReturnType<typeof createFixtures>>;
beforeAll(async () => {
  f = await createFixtures();
  expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: true }).eq('singleton', true)).error).toBeNull();
});
afterAll(async () => { await f?.close(); });

it('rejects a restore that waits for the photo lock until after retention expires (AC-9)', async () => {
  const jobId = randomUUID(); const photoId = randomUUID(); const batchId = randomUUID();
  const locker = await f.sql.connect();
  const restorer = await f.sql.connect();
  let pending: Promise<{ error: Error | null }> | undefined;
  try {
    await f.sql.query('insert into public.jobs(id,job_number,name) values($1,$2,$3)', [jobId, `expiry-${jobId}`, 'Lock-wait expiry']);
    // One database clock value keeps the exact 30-day constraint intact;
    // text timestamps preserve microseconds in the expected-state comparison.
    const seeded = await f.sql.query(`
      with deadline as (select clock_timestamp()+interval '5 seconds' as expires)
      insert into public.photos(id,job_id,uploader_id,kind,captured_at,original_path,deleted_at,deleted_by,purge_after)
      select $1,$2,$3,'image',clock_timestamp(),$4,expires-interval '30 days',$3,expires from deadline
      returning deleted_at::text,purge_after::text`, [photoId, jobId, f.employeeA.id, `originals/${f.employeeA.id}/${photoId}/retained.jpg`]);
    const { deleted_at: deletedAt, purge_after: purgeAfter } = seeded.rows[0];
    await f.sql.query("insert into public.photo_action_batches(id,created_by,origin,action) values($1,$2,'ui','restore')", [batchId, f.employeeA.id]);
    await f.sql.query('insert into public.photo_action_items(batch_id,photo_id,expected_job_id,expected_deleted_at) values($1,$2,$3,$4)', [batchId, photoId, jobId, deletedAt]);
    expect((await f.admin.rpc('photo_approve_action', { p_actor: f.employeeA.id, p_batch_id: batchId })).error).toBeNull();
    expect((await f.sql.query(`select i.expected_deleted_at=p.deleted_at as matches
      from public.photo_action_items i join public.photos p on p.id=i.photo_id where i.batch_id=$1`, [batchId])).rows[0].matches).toBe(true);

    await locker.query('begin');
    await locker.query('select id from public.photos where id=$1 for update', [photoId]);
    const restorerPid = (await restorer.query('select pg_backend_pid() as pid')).rows[0].pid;
    await restorer.query('set role service_role');
    expect((await locker.query('select clock_timestamp() < $1::timestamptz as before_expiry', [purgeAfter])).rows[0].before_expiry).toBe(true);
    pending = restorer.query('select public.photo_apply_action($1,$2,$3)', [f.employeeA.id, batchId, photoId])
      .then(() => ({ error: null }), error => ({ error: error as Error }));
    // Observe an actual blocking lock before waiting out the retention window.
    await expect.poll(async () => (await f.sql.query(
      "select wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0 as blocked from pg_stat_activity where pid=$1",
      [restorerPid])).rows[0]?.blocked, { timeout: 2000 }).toBe(true);
    expect((await locker.query('select clock_timestamp() < $1::timestamptz as before_expiry', [purgeAfter])).rows[0].before_expiry).toBe(true);
    await locker.query("select pg_sleep_until($1::timestamptz+interval '50 milliseconds')", [purgeAfter]);
    await locker.query('commit');

    expect((await pending).error?.message).toBe('conflict');
    const saved = await f.sql.query('select deleted_at::text,purge_after::text from public.photos where id=$1', [photoId]);
    expect(saved.rows).toEqual([{ deleted_at: deletedAt, purge_after: purgeAfter }]);
    expect((await f.sql.query('select status from public.photo_action_items where batch_id=$1', [batchId])).rows[0].status).toBe('pending');
  } finally {
    await locker.query('rollback');
    await pending;
    await restorer.query('reset role');
    locker.release(); restorer.release();
  }
});
