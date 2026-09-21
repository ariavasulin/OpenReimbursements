"use client";

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "lucide-react";

import { formatUSPhoneNumber } from '@/lib/phone';
import { isPhotosHost } from '@/lib/cookieDomain';

/** Seconds before "Resend code" can be pressed (again). */
const RESEND_WAIT_SECONDS = 30;

/**
 * Is this sign-in for the photo library? On the photos address, or when the
 * page the person is headed to is a photos page (previews and local runs have
 * no photos address of their own).
 */
function isPhotosSignIn(): boolean {
  const next = new URLSearchParams(window.location.search).get('next') ?? '';
  return isPhotosHost(window.location.hostname) || next === '/photos' || next.startsWith('/photos/') || next.startsWith('/photos?');
}

function getPostLoginPath(): string {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  // Open-redirect guard: only same-origin absolute paths.
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    return next;
  }
  return isPhotosHost(window.location.hostname) ? '/photos' : '/employee';
}

async function needsNamePrompt(user: {
  id: string;
  phone?: string | null;
}): Promise<boolean> {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('full_name')
    .eq('user_id', user.id)
    .single();

  if (error) {
    // PGRST116 = no profile row yet -> needs a name. On transient errors,
    // don't block login behind the prompt.
    return error.code === 'PGRST116';
  }

  const name = (profile.full_name ?? '').trim();
  // Supabase stores phone without "+"; compare both forms
  const phone = user.phone ?? '';
  return !name || name === 'Employee' || name === phone || name === `+${phone}`;
}

export default function LoginPage() {
  const [phoneNumberInput, setPhoneNumberInput] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [needsName, setNeedsName] = useState(false);
  const [fullNameInput, setFullNameInput] = useState('');
  const [photosSignIn, setPhotosSignIn] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const router = useRouter();

  // The browser tab and the heading say which product this is. Decided on the
  // client because it depends on the address the page was opened at.
  useEffect(() => {
    if (!isPhotosSignIn()) return;
    setPhotosSignIn(true);
    document.title = 'DWS Photos';
  }, []);

  // Counts "Resend code" down to zero, one second at a time.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const mountedRef = useRef(true);

  const routeSignedInUser = async (user: { id: string; phone?: string | null }) => {
    const promptForName = await needsNamePrompt(user);

    if (!mountedRef.current) return;

    if (promptForName) {
      setNeedsName(true);
      setMessage(null);
      setLoading(false);
    } else {
      window.location.replace(getPostLoginPath());
    }
  };

  useEffect(() => {
    if (!mountedRef.current) return;

    const checkInitialAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (session && session.user) {
          await routeSignedInUser(session.user);
        }
      } catch (err) {
      }
    };

    checkInitialAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      () => {}
    );

    return () => {
      mountedRef.current = false;
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleSendOtp = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const resending = otpSent;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const formattedPhone = formatUSPhoneNumber(phoneNumberInput);
      if (!formattedPhone) {
        setError('Please enter a valid US phone number.');
        setLoading(false);
        return;
      }
      const response = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send OTP');
      }
      setMessage(resending ? 'We sent a new code. Please check your phone.' : 'Login code sent successfully! Please check your phone.');
      setOtpSent(true);
      setOtp('');
      setResendIn(RESEND_WAIT_SECONDS);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
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
      const formattedPhone = formatUSPhoneNumber(phoneNumberInput);
      if (!formattedPhone) {
        setError('Please enter a valid US phone number.');
        setLoading(false);
        return;
      }
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, token: otp }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify OTP');
      }
      
      // Must manually set session on client-side Supabase instance after server-side OTP verify
      if (data.session) {
        const { access_token, refresh_token } = data.session;
        
        if (typeof access_token === 'string' && typeof refresh_token === 'string') {
          const { error: setSessionError } = await supabase.auth.setSession({
            access_token,
            refresh_token,
          });
          
          if (setSessionError) {
            setError('Failed to update session locally. Please try again.');
            return;
          }
          
          setMessage('Login successful! Redirecting...');

          const signedInUser = data.user ?? data.session.user;
          setTimeout(() => {
            routeSignedInUser(signedInUser);
          }, 500);

        } else {
          setError('Received invalid session data. Please try again.');
          return;
        }
      } else {
        setError('Login completed but session data was not received. Please try again.');
        return;
      }
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
      setLoading(false);
    }
  };

  const handleSubmitName = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullNameInput }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save your name');
      }

      window.location.replace(getPostLoginPath());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-start md:justify-center bg-[#222222] px-4 py-8 overflow-hidden">
      <div className="w-full max-w-xs space-y-8">
        <div className="flex flex-col items-center justify-center">
          <div className="mb-8 flex items-center justify-center">
            <Image
              src="/images/logo.png"
              alt="Design Workshops Logo"
              width={300}
              height={300}
              className="h-auto w-40 object-contain"
              priority
            />
          </div>
          {photosSignIn && (
            <h1 className="mb-1 text-center text-2xl font-semibold tracking-wide text-white">
              DWS <span className="text-[#2680FC]">Photos</span>
            </h1>
          )}
          <p className="mt-2 text-center text-base text-gray-400">
            {needsName
              ? "One last thing — what's your name?"
              : otpSent
                ? 'Enter the code sent to your phone'
                : 'Sign in with your phone number'}
          </p>
        </div>

        {error && <p className="text-base text-red-400 bg-red-900/30 p-3 rounded-md text-center">{error}</p>}
        {message && <p className="text-base text-green-400 bg-green-900/30 p-3 rounded-md text-center">{message}</p>}

        {needsName ? (
          <form onSubmit={handleSubmitName} className="mt-8 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="fullName" className="text-base text-white">
                Full Name
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder="e.g. Marco Reyes"
                value={fullNameInput}
                onChange={(e) => setFullNameInput(e.target.value)}
                required
                className="h-auto min-h-11 text-base md:text-base bg-[#333333] border-[#444444] text-white placeholder:text-gray-400 focus:border-[#2680FC] focus:ring-[#2680FC]"
                disabled={loading}
                autoComplete="name"
                maxLength={120}
              />
              <p className="text-base text-gray-400">Shown next to everything you upload</p>
            </div>
            <Button
              type="submit"
              className="h-auto min-h-11 w-full whitespace-normal text-base bg-[#2680FC] hover:bg-[#1a6fd8] text-white"
              disabled={loading || !fullNameInput.trim()}
            >
              {loading ? 'Saving...' : 'Continue'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        ) : !otpSent ? (
          <form onSubmit={handleSendOtp} className="mt-8 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="phone" className="text-base text-white">
                Phone Number
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={phoneNumberInput}
                onChange={(e) => setPhoneNumberInput(e.target.value)}
                required
                className="h-auto min-h-11 text-base md:text-base bg-[#333333] border-[#444444] text-white placeholder:text-gray-400 focus:border-[#2680FC] focus:ring-[#2680FC]"
                disabled={loading}
                autoComplete="tel"
              />
            </div>
            <Button type="submit" className="h-auto min-h-11 w-full whitespace-normal text-base bg-[#2680FC] hover:bg-[#1a6fd8] text-white" disabled={loading || !phoneNumberInput}>
              {loading ? 'Sending Code...' : 'Send Code'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="mt-8 space-y-6">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <Label htmlFor="otp" className="text-base text-white">
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
                  className="min-h-11 shrink-0 px-2 text-base text-[#8bbaff] hover:text-white"
                  disabled={loading}
                >
                  Change Number
                </button>
              </div>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                placeholder="Enter 4-digit code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                required
                className="h-auto min-h-11 text-base md:text-base bg-[#333333] border-[#444444] text-white placeholder:text-gray-400 focus:border-[#2680FC] focus:ring-[#2680FC]"
                maxLength={4}
                disabled={loading}
                autoComplete="one-time-code"
              />
              <p className="text-base text-gray-400">We sent a code to {formatUSPhoneNumber(phoneNumberInput) || phoneNumberInput}</p>
              <p className="pt-1 text-base text-gray-300">
                Didn&apos;t get it?{' '}
                <button
                  type="button"
                  onClick={() => void handleSendOtp()}
                  disabled={loading || resendIn > 0}
                  className="min-h-11 text-base font-medium text-[#8bbaff] hover:text-white disabled:text-gray-500"
                >
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
              </p>
            </div>
            <Button type="submit" className="h-auto min-h-11 w-full whitespace-normal text-base bg-[#2680FC] hover:bg-[#1a6fd8] text-white" disabled={loading || otp.length !== 4}>
              {loading ? 'Verifying...' : 'Verify & Login'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}