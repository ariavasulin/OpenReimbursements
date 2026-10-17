import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { needsNameFor } from '@/lib/needs-name';
import { NextResponse } from 'next/server';

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Whether the sign-in page should ask for a name, read here so the phone does
 * not make its own profile query after signing in (one round trip fewer).
 * No profile row yet (PGRST116) means yes; any other read error means no, so a
 * hiccup never holds sign-in behind the name prompt. Same rule as the page's
 * own fallback query.
 */
async function needsNameAfterSignIn(supabase: ServerClient, user: { id: string; phone?: string | null }): Promise<boolean> {
  const { data, error } = await supabase.from('user_profiles').select('full_name').eq('user_id', user.id).single();
  if (error) return error.code === 'PGRST116';
  return needsNameFor(data.full_name, user.phone);
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();

  try {
    const { phone, token } = await request.json();

    if (!phone || !token) {
      return NextResponse.json({ error: 'Phone number and OTP token are required' }, { status: 400 });
    }

    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return NextResponse.json({ error: 'Invalid phone number format. Use E.164 format (e.g., +12223334444)' }, { status: 400 });
    }

    const otpRegex = /^\d{4}$/;
    if (!otpRegex.test(token)) {
      return NextResponse.json({ error: 'Invalid OTP format. Must be 4 digits.' }, { status: 400 });
    }

    const { data, error } = await supabase.auth.verifyOtp({
      phone: phone,
      token: token,
      type: 'sms',
    });

    if (error) {
      return NextResponse.json({ error: error.message || 'Failed to verify OTP' }, { status: error.status || 500 });
    }

    if (!data.session) {
        return NextResponse.json({ error: 'OTP verification successful, but no session returned. This might indicate the OTP was already used or expired.' }, { status: 401 });
    }

    // The session just verified is the one this client now sends, so the read
    // goes through the person's own row rules, as the page's query did.
    const needsName = data.user ? await needsNameAfterSignIn(supabase, data.user) : undefined;

    return NextResponse.json({ success: true, message: 'OTP verified successfully', user: data.user, session: data.session, needsName });

  } catch (error) {
    console.error('Verify OTP endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
    return NextResponse.json({ error: `Failed to process request: ${errorMessage}` }, { status: 500 });
  }
}
