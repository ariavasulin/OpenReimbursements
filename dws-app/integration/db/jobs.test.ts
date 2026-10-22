import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

describe('hand-made photo projects (photo-folders AC-2, AC-3, AC-5, AC-6)', () => {
  let f: Awaited<ReturnType<typeof createFixtures>>;
  const gate = async (open: boolean) =>
    expect((await f.admin.from('photo_release_state').update({ photo_writes_enabled: open }).eq('singleton', true)).error).toBeNull();
  const create = (name: string, number?: string) =>
    f.admin.rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: name, p_job_number: number ?? null });

  beforeAll(async () => { f = await createFixtures(); await gate(true); });
  afterAll(async () => { await f?.close(); });

  it('generates a P- code without a number and keeps a typed number', async () => {
    const blank = await create('  Office   party ');
    expect(blank.error).toBeNull();
    expect(blank.data.status).toBe('created');
    expect(blank.data.job.name).toBe('Office party');
    expect(blank.data.job.job_number).toMatch(/^P-\d+$/);
    const typed = await create('Smith kitchen', ` ${randomUUID().slice(0, 8)} `);
    expect(typed.data.status).toBe('created');
    expect(typed.data.job.job_number).not.toMatch(/^P-/);
    const saved = await f.admin.from('jobs').select('created_by,synced_at,is_active').eq('id', typed.data.job.id).single();
    expect(saved.data).toEqual({ created_by: f.employeeA.id, synced_at: null, is_active: true });
  });

  it('returns the existing job for a repeated number and creates nothing', async () => {
    const number = randomUUID().slice(0, 8);
    const first = await create('First name', number);
    const again = await create('Different name', number);
    expect(again.data.status).toBe('exists');
    expect(again.data.job).toEqual(first.data.job);
    expect((await f.admin.from('jobs').select('id', { count: 'exact' }).eq('job_number', number)).count).toBe(1);
  });

  it('rejects an empty or oversized name and a typed P- code', async () => {
    expect((await create('   ')).error?.message).toBe('invalid_input');
    expect((await create('x'.repeat(121))).error?.message).toBe('invalid_input');
    expect((await create('Squatter', 'p-999')).error?.message).toBe('job_number_reserved');
  });

  it('renames any job without changing its number', async () => {
    const job = (await create('Before')).data.job;
    const renamed = await f.admin.rpc('photo_rename_job', { p_actor: f.employeeB.id, p_job_id: job.id, p_name: 'After' });
    expect(renamed.error).toBeNull();
    expect(renamed.data.job).toEqual({ ...job, name: 'After' });
    expect((await f.admin.rpc('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: randomUUID(), p_name: 'x' })).error?.message).toBe('not_found');
  });

  it('refuses to rename or renumber an office job', async () => {
    const number = String(randomInt(900_000_000, 999_999_999));
    const office = await f.sql.query(`insert into public.jobs (job_number, name, is_active, synced_at)
      values ($1, 'Office name', true, now()) returning id`, [number]);
    const id = office.rows[0].id as string;
    try {
      const rename = (p_name: string, p_job_number?: string) => f.admin.rpc('photo_rename_job',
        { p_actor: f.employeeA.id, p_job_id: id, p_name, p_job_number: p_job_number ?? null });
      expect((await rename('App name')).error?.message).toBe('job_office_managed');
      expect((await rename('Office name', randomUUID().slice(0, 8))).error?.message).toBe('job_office_managed');
      // Sending back what it already has changes nothing and is not refused.
      expect((await rename(' Office  name ', number)).error).toBeNull();
      expect((await f.sql.query('select name, job_number from public.jobs where id = $1', [id])).rows)
        .toEqual([{ name: 'Office name', job_number: number }]);
    } finally { await f.sql.query('delete from public.jobs where id = $1', [id]); }
  });

  it('refuses both with the write gate closed, an unknown actor, or a session role', async () => {
    const job = (await create('Gated')).data.job;
    expect((await f.admin.rpc('photo_create_job', { p_actor: randomUUID(), p_name: 'Nobody' })).error?.message).toBe('invalid_actor');
    expect((await f.employeeA.client.rpc('photo_create_job', { p_actor: f.employeeA.id, p_name: 'Direct' })).error).not.toBeNull();
    await gate(false);
    expect((await create('Closed')).error?.message).toBe('photo_gate_closed');
    expect((await f.admin.rpc('photo_rename_job', { p_actor: f.employeeA.id, p_job_id: job.id, p_name: 'Closed' })).error?.message).toBe('photo_gate_closed');
    await gate(true);
  });
});
