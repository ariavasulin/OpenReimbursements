// Integration tooling accepts only a harness-created, loopback Supabase stack.
export function assertLocalTestTarget(env = process.env) {
  const project = env.DWS_TEST_PROJECT;
  if (!project || !/^dws-test-[a-f0-9]{12}$/.test(project)) {
    throw new Error('Integration tests require a disposable dws-test project; use npm run test:db or test:routes');
  }
  for (const [name, protocol] of [['DWS_TEST_DATABASE_URL', 'postgresql:'], ['NEXT_PUBLIC_SUPABASE_URL', 'http:']]) {
    const value = env[name];
    if (!value) throw new Error(`Missing isolated ${name}`);
    const url = new URL(value);
    if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || !url.port || url.search || url.hash) {
      throw new Error(`Refusing non-local integration target in ${name}`);
    }
    if (name === 'DWS_TEST_DATABASE_URL' && (url.pathname !== '/postgres' || url.username !== 'postgres')) {
      throw new Error('Refusing unexpected integration database identity');
    }
  }
  if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing isolated Auth credentials');
  return project;
}

export async function assertDatabaseIdentity(sql, env = process.env) {
  const project = assertLocalTestTarget(env);
  const result = await sql.query('select project_id from dws_test_harness.identity');
  if (result.rows.length !== 1 || result.rows[0].project_id !== project) {
    throw new Error('Refusing database without matching disposable harness identity');
  }
}
