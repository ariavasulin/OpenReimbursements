import { supabase } from '@/lib/supabaseClient';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { phone } = await request.json();

    if (!phone) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
    }

    // Basic E.164 format validation (you might want a more robust library for this)
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return NextResponse.json({ error: 'Invalid phone number format. Use E.164 format (e.g., +12223334444)' }, { status: 400 });
    }

    const { error } = await supabase.auth.signInWithOtp({
      phone: phone,
    });

    if (error) {
      console.error('Supabase OTP send error:', error);
      return NextResponse.json({ error: error.message || 'Failed to send OTP' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Send OTP endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
    return NextResponse.json({ error: `Failed to process request: ${errorMessage}` }, { status: 500 });
  }
}