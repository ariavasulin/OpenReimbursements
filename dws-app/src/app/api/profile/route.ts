import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

// PATCH /api/profile — set the signed-in user's own full_name.
// Used by the one-time name prompt on first login. Scoped to auth.uid():
// the update targets only the caller's row (RLS enforces the same).
export async function PATCH(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const fullNameRaw = (body as { full_name?: unknown })?.full_name;
  if (typeof fullNameRaw !== 'string') {
    return NextResponse.json({ error: 'full_name is required' }, { status: 400 });
  }
  const fullName = fullNameRaw.trim();
  if (fullName.length === 0 || fullName.length > 120) {
    return NextResponse.json(
      { error: 'full_name must be between 1 and 120 characters' },
      { status: 400 }
    );
  }

  // Update the caller's own row. If no row exists yet (the signup trigger
  // normally creates one, but be safe), insert a default-role row instead.
  // Deliberately NOT an upsert: an upsert would overwrite `role` on existing
  // rows (e.g. reset an admin to employee).
  const { data: updated, error: updateError } = await supabase
    .from('user_profiles')
    .update({ full_name: fullName })
    .eq('user_id', session.user.id)
    .select('user_id');

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (!updated || updated.length === 0) {
    const { error: insertError } = await supabase.from('user_profiles').insert({
      user_id: session.user.id,
      role: 'employee',
      full_name: fullName,
    });
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true, full_name: fullName });
}
