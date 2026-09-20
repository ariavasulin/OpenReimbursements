import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { assertDatabaseIdentity, assertLocalTestTarget } from '../scripts/test-local-target.mjs';
import { AUTH_COOKIE_NAME } from '../src/lib/cookieDomain';

export type FixtureActor = {
  id: string;
  client: SupabaseClient;
  cookie: string;
  cookies: Array<{ name: string; value: string }>;
};

export async function createFixtures() {
  assertLocalTestTarget();
  const sql = new pg.Pool({ connectionString: process.env.DWS_TEST_DATABASE_URL, max: 12 });
  await assertDatabaseIdentity(sql);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const anon = createClient(url, anonKey, options);
  async function actor(phone: string, role: 'employee' | 'admin'): Promise<FixtureActor> {
    let id = (await sql.query('select id from auth.users where phone = $1', [phone])).rows[0]?.id as string | undefined;
    if (!id) {
      const created = await admin.auth.admin.createUser({ phone, phone_confirm: true });
      if (created.error || !created.data.user) throw new Error(`Cannot create isolated Auth fixture: ${created.error?.message}`);
      id = created.data.user.id;
    }
    await sql.query('update public.user_profiles set role = $1 where user_id = $2', [role, id]);
    const cookies: Array<{ name: string; value: string }> = [];
    const client = createServerClient(url, anonKey, {
      auth: { autoRefreshToken: false },
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll: () => cookies,
        setAll: values => {
          for (const { name, value } of values) {
            const index = cookies.findIndex(cookie => cookie.name === name);
            if (index >= 0) cookies.splice(index, 1);
            if (value) cookies.push({ name, value });
          }
        },
      },
    });
    const requested = await client.auth.signInWithOtp({ phone });
    if (requested.error) throw requested.error;
    const signedIn = await client.auth.verifyOtp({ phone, token: '123456', type: 'sms' });
    if (signedIn.error || signedIn.data.user?.id !== id) throw new Error(`Cannot sign in isolated SMS fixture: ${signedIn.error?.message}`);
    const verified = await client.auth.getUser();
    if (verified.error || verified.data.user?.id !== id) throw new Error('Isolated Auth session verification failed');
    return { id, client, cookies, cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') };
  }
  try {
    const employeeA = await actor('15555550101', 'employee');
    const employeeB = await actor('15555550102', 'employee');
    const administrator = await actor('15555550103', 'admin');
    const storage = await admin.storage.getBucket('photos');
    if (storage.error || !storage.data.public) throw new Error('Isolated public photos bucket is unavailable');
    return { admin, anon, employeeA, employeeB, administrator, sql, close: () => sql.end() };
  } catch (error) {
    await sql.end();
    throw error;
  }
}
