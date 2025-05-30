import { supabase } from '@/lib/supabaseClient';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { phone, token } = await request.json();

    if (!phone || !token) {
      return NextResponse.json({ error: 'Phone number and OTP token are required' }, { status: 400 });
    }

    // Basic E.164 format validation for phone
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return NextResponse.json({ error: 'Invalid phone number format. Use E.164 format (e.g., +12223334444)' }, { status: 400 });
    }

    // Basic OTP format validation (e.g., 6 digits)
    const otpRegex = /^\d{6}$/;
    if (!otpRegex.test(token)) {
      return NextResponse.json({ error: 'Invalid OTP format. Must be 6 digits.' }, { status: 400 });
    }

    const { data, error } = await supabase.auth.verifyOtp({
      phone: phone,
      token: token,
      type: 'sms', // Specify the type directly
    });

    if (error) {
      console.error('Supabase OTP verification error:', error);
      return NextResponse.json({ error: error.message || 'Failed to verify OTP' }, { status: error.status || 500 });
    }

    if (!data.session) {
        return NextResponse.json({ error: 'OTP verification successful, but no session returned. This might indicate the OTP was already used or expired.' }, { status: 401 });
    }
    
    // Session is automatically set by Supabase client library if successful
    // You can return the session or user data if needed by the client, though often not necessary
    // as the client-side Supabase instance will update its auth state.
    return NextResponse.json({ success: true, message: 'OTP verified successfully', user: data.user, session: data.session });

  } catch (error) {
    console.error('Verify OTP endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
    return NextResponse.json({ error: `Failed to process request: ${errorMessage}` }, { status: 500 });
  }
}