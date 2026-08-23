import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type AdminGate =
  | { response: NextResponse; supabase?: never; userId?: never }
  | { response?: never; supabase: SupabaseServerClient; userId: string };

/** Session -> user_profiles.role -> 403 gate for admin-only route handlers. */
export async function requireAdmin(): Promise<AdminGate> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    return {
      response: NextResponse.json({ error: 'Failed to get session' }, { status: 500 }),
    };
  }

  if (!session) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return {
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    };
  }

  return { supabase, userId: session.user.id };
}
