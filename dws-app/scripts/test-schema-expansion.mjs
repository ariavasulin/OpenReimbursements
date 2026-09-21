import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertDatabaseIdentity } from './test-local-target.mjs';
import { replayMigrations, assertValidIndexes } from './test-migrations.mjs';

const legacyLast = '20260823120400_photo_tags_unbounded.sql';
export async function verifyExpansion(sql, env) {
  await replayMigrations(sql, { through: legacyLast });
  await assertDatabaseIdentity(sql, env);
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomUUID();
  const created = await admin.auth.admin.createUser({ phone: '15555550999', phone_confirm: true, password });
  if (created.error || !created.data.user) throw new Error(`Cannot seed isolated expansion actor: ${created.error?.message}`);
  const actor = created.data.user.id;
  const jobA = randomUUID(), jobB = randomUUID();
  await sql.query("insert into public.jobs(id,job_number,name) values ($1,'harness-legacy-a','Preserved legacy A'),($2,'harness-legacy-b','Preserved legacy B')", [jobA, jobB]);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (let i = 0; i < ids.length; i++) {
    await sql.query('insert into public.photos(id,job_id,uploader_id,kind,original_path,original_name,original_bytes,content_sha256,captured_at) values($1,$2,$3,\'image\',$4,$5,3,$6,now())', [ids[i], i === 1 ? jobB : jobA, actor, `${actor}/${ids[i]}/original.jpg`, `retained-${i}.jpg`, i === 2 ? null : 'a'.repeat(64)]);
  }
  const snapshot = () => sql.query('select * from public.photos where id=any($1::uuid[]) order by id', [ids]);
  const before = (await snapshot()).rows;
  const first = await replayMigrations(sql, { after: legacyLast });
  assert.ok(first.length, 'At least one additive hosted-photo migration must exist');
  await replayMigrations(sql, { after: legacyLast });
  // Expansion must also preserve the old application's unqualified relation
  // embed. A second photos -> user_profiles FK makes PostgREST return PGRST201.
  const legacyClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await legacyClient.auth.signInWithPassword({ phone: '15555550999', password });
  if (signedIn.error) throw signedIn.error;
  const legacyRead = await legacyClient.from('photos')
    .select('id,uploader:user_profiles(full_name),job:jobs(id,job_number,name)')
    .in('id', ids);
  assert.equal(legacyRead.error, null, 'Old unqualified uploader embed must survive additive expansion');
  assert.equal(legacyRead.data?.length, 3, 'Old application must still read all retained active fixture rows');
  // The one legacy column removed on purpose (photo-albums plan, Decision 6).
  // It may go only because it held nothing; every other field must survive.
  const droppedOnPurpose = ['sheet_number'];
  for (const column of droppedOnPurpose) {
    assert.ok(before.every(row => row[column] === null), `Dropped column ${column} must have been empty`);
  }
  const originalColumns = Object.keys(before[0]).filter(key => !droppedOnPurpose.includes(key));
  const keep = row => Object.fromEntries(originalColumns.map(key => [key, row[key]]));
  const afterRows = (await snapshot()).rows;
  for (const column of droppedOnPurpose) {
    assert.ok(afterRows.every(row => !(column in row)), `Column ${column} must be gone after replay`);
  }
  assert.deepEqual(afterRows.map(keep), before.map(keep), 'Expansion must preserve every legacy source field');
  assert.equal((await sql.query('select count(*)::int as n from public.photos where id=any($1::uuid[]) and deleted_at is null and duplicate_of is null', [ids])).rows[0].n, 3, 'Expansion must perform no photo cleanup');
  assert.deepEqual((await sql.query('select photo_writes_enabled,mcp_enabled,repair_enabled from public.photo_release_state')).rows, [{ photo_writes_enabled: false, mcp_enabled: false, repair_enabled: false }]);
  assert.equal((await sql.query("select has_table_privilege('authenticated','public.photos','INSERT') as permitted")).rows[0].permitted, true, 'Expansion must not install the operator write boundary');
  for (const gate of ['writes', 'mcp', 'repair']) {
    await assert.rejects(sql.query('select public.photo_require_gate($1)', [gate]), /photo_gate_closed/);
  }
  await assertValidIndexes(sql);
  await sql.query('delete from public.photos where id=any($1::uuid[])', [ids]);
  await sql.query('delete from public.jobs where id=any($1::uuid[])', [[jobA, jobB]]);
  const removed = await admin.auth.admin.deleteUser(actor);
  if (removed.error) throw removed.error;
  console.log('Verified additive replay twice: three legacy photos unchanged, cross-job hashes retained, gates closed, old grants and unqualified uploader read retained, all indexes valid');
}
