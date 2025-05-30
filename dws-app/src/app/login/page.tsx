// src/app/login/page.tsx
"use client";

import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabaseClient';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'; // Import Session and AuthChangeEvent
import { useRouter } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";

export default function LoginPage() {
  // const [phone, setPhone] = useState(''); // phone state will be handled by phoneNumberInput
  const [phoneNumberInput, setPhoneNumberInput] = useState(''); // For the input field
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const router = useRouter();

  // Redirect if already logged in
  useEffect(() => { // Combined initial check and auth state listener
    const processAuthSession = async (session: Session | null, eventType?: AuthChangeEvent | string) => {
      console.log('[Login Page] processAuthSession. EventType:', eventType, 'Session object:', session);
      if (session && session.user) {
        console.log('[Login Page] Session and session.user confirmed. User ID:', session.user.id, 'Attempting profile fetch...');
        // Restore original profile fetching logic, ensuring all router.replace calls are in setTimeout
        try {
          const { data: profile, error: profileError } = await supabase
            .from('user_profiles')
            .select('user_id, role, full_name')
            .eq('user_id', session.user.id)
            .single();

          if (profileError) {
            if (profileError.code === 'PGRST116') {
              console.warn(`[Login Page] Profile not found for user ${session.user.id} (PGRST116). Defaulting to /employee.`);
              setTimeout(() => {
                console.log("[Login Page] Executing router.replace('/employee') due to PGRST116.");
                router.replace('/employee');
              }, 0);
            } else {
              console.error("[Login Page] Error fetching profile on auth change:", profileError.message);
              // Stay on login page if there's an unexpected error fetching profile
            }
            return; // Important to return after handling profileError
          }

          if (profile) {
            console.log("[Login Page] Profile fetched on auth change:", profile);
            let targetPath = '/employee'; // Default
            if (profile.role === 'employee') {
              targetPath = '/employee';
            } else if (profile.role === 'admin') {
              targetPath = '/dashboard';
            } else {
              console.warn("[Login Page] Unknown user role:", profile.role, "- defaulting to /employee.");
            }
            console.log(`[Login Page] Attempting redirect to ${targetPath}...`);
            setTimeout(() => {
              console.log(`[Login Page] Executing router.replace('${targetPath}')`);
              router.replace(targetPath);
            }, 0);
          } else {
            // This case implies profileError was not 'PGRST116' but profile is still null.
            console.warn("[Login Page] Profile data is null after fetch (and not PGRST116) for user:", session.user.id, "- defaulting to /employee.");
            setTimeout(() => {
              console.log("[Login Page] Executing router.replace('/employee') due to null profile.");
              router.replace('/employee');
            }, 0);
          }
        } catch (e) {
          console.error("[Login Page] Exception during profile fetch in handleAuthChange:", e);
          console.log("[Login Page] Exception caught, attempting redirect to /employee as fallback...");
          setTimeout(() => {
            console.log("[Login Page] Executing router.replace('/employee') due to exception.");
            router.replace('/employee');
          }, 0);
        }
      } // This closes the `if (session && session.user)` block
      // If no session, or if session.user is null, this function implicitly returns undefined (which is fine for Promise<void>)
    };
  
      // Initial check
      const checkInitialSession = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        await processAuthSession(session, 'INITIAL_SESSION_CHECKED');
      };
      checkInitialSession();
  
      // Listen for auth changes
      const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
        // This wrapper is not async, satisfying onAuthStateChange's direct type expectation better.
        // The actual async work is inside processAuthSession.
        processAuthSession(session, event);
      });
  
      return () => {
        authListener?.subscription?.unsubscribe();
      };
    }, [router]); // Restored router to dependency array
  // Removed the useEffect that was watching the `message` state for redirection.
  // The main useEffect above now handles all redirection based on auth state and role.

  const handleSendOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Assuming US numbers for now, add country code logic later.
        // The prototype doesn't have explicit country code handling, so we'll keep it simple.
        // For production, a proper phone input library (e.g., react-phone-number-input) would be better.
        body: JSON.stringify({ phone: `+1${phoneNumberInput.replace(/\D/g, '')}` }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send OTP');
      }
      setMessage('OTP sent successfully! Please check your phone.');
      setOtpSent(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
      console.error('Send OTP error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `+1${phoneNumberInput.replace(/\D/g, '')}`, token: otp }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify OTP');
      }
      
      // The API route returned a session. We need to set it on the client-side Supabase instance.
      if (data.session) {
        const { access_token, refresh_token } = data.session;
        // Ensure access_token and refresh_token are strings, as setSession expects
        if (typeof access_token === 'string' && typeof refresh_token === 'string') {
          const { error: setSessionError } = await supabase.auth.setSession({
            access_token,
            refresh_token,
          });
          if (setSessionError) {
            console.error('[Login Page] Error setting client session:', setSessionError);
            setError('Failed to update session locally. Please try again.');
            return; // Stop further processing if session can't be set
          }
          console.log('[Login Page] Client session manually set.');
        } else {
          console.error('[Login Page] Invalid token types received from API for setSession.');
          setError('Received invalid session data. Please try again.');
          return;
        }
      } else {
        console.error('[Login Page] No session returned from verify-otp API to set client-side.');
        setError('Login completed but session data was not received. Please try again.');
        return; // Stop if no session data
      }
      
      setMessage('Login successful! Redirecting...');
      
      // Let's check the client-side session immediately AFTER setting it
      const { data: clientSessionData, error: clientSessionError } = await supabase.auth.getSession();
      console.log('[Login Page] Client session AFTER supabase.auth.setSession():', {
        session: clientSessionData.session,
        error: clientSessionError
      });
      console.log('[Login Page] API response data from verify-otp (for reference):', data);


      // onAuthStateChange in the main useEffect should now pick up the new session and handle the redirect.
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
      console.error('Verify OTP error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-[#222222] px-4 py-8 overflow-hidden">
      <div className="w-full max-w-xs space-y-8">
        <div className="flex flex-col items-center justify-center">
          <div className="mb-8 flex items-center justify-center">
            <Image
              src="/images/logo.png" // Make sure this path is correct in dws-app/public
              alt="Design Workshops Logo"
              width={300}
              height={300}
              className="h-auto w-40 object-contain"
              priority
            />
          </div>
          <p className="mt-2 text-center text-sm text-gray-400">
            {otpSent ? 'Enter the code sent to your phone' : 'Sign in to upload and track your receipts'}
          </p>
        </div>

        {error && <p className="text-sm text-red-400 bg-red-900/30 p-3 rounded-md text-center">{error}</p>}
        {message && <p className="text-sm text-green-400 bg-green-900/30 p-3 rounded-md text-center">{message}</p>}

        {!otpSent ? (
          <form onSubmit={handleSendOtp} className="mt-8 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="phone" className="text-white">
                Phone Number
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={phoneNumberInput}
                onChange={(e) => setPhoneNumberInput(e.target.value)}
                required
                className="bg-[#333333] border-[#444444] text-white placeholder:text-gray-500 focus:border-[#2680FC] focus:ring-[#2680FC]"
                disabled={loading}
                autoComplete="tel"
              />
            </div>
            <Button type="submit" className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white" disabled={loading || !phoneNumberInput}>
              {loading ? 'Sending Code...' : 'Send Code'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="mt-8 space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="otp" className="text-white">
                  One-Time Code
                </Label>
                <button
                  type="button"
                  onClick={() => {
                    setOtpSent(false);
                    setOtp('');
                    setError(null);
                    setMessage(null);
                  }}
                  className="text-sm text-[#2680FC] hover:text-[#1a6fd8]"
                  disabled={loading}
                >
                  Change Number
                </button>
              </div>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                placeholder="Enter 6-digit code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                required
                className="bg-[#333333] border-[#444444] text-white placeholder:text-gray-500 focus:border-[#2680FC] focus:ring-[#2680FC]"
                maxLength={6}
                disabled={loading}
                autoComplete="one-time-code"
              />
              <p className="text-xs text-gray-400">We sent a code to +1{phoneNumberInput.replace(/\D/g, '')}</p>
            </div>
            <Button type="submit" className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white" disabled={loading || otp.length !== 6}>
              {loading ? 'Verifying...' : 'Verify & Login'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}