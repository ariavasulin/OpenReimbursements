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

export default function LoginPage() {
  const [phoneNumberInput, setPhoneNumberInput] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const router = useRouter();
  
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!mountedRef.current) return;

    const checkInitialAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session && session.user) {
          window.location.replace('/employee');
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

  const handleSendOtp = async (e: React.FormEvent<HTMLFormElement>) => {
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
      const response = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send OTP');
      }
      setMessage('Login code sent successfully! Please check your phone.');
      setOtpSent(true);
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
          
          setTimeout(() => {
            window.location.replace('/employee');
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
                placeholder="Enter 4-digit code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                required
                className="bg-[#333333] border-[#444444] text-white placeholder:text-gray-500 focus:border-[#2680FC] focus:ring-[#2680FC]"
                maxLength={4}
                disabled={loading}
                autoComplete="one-time-code"
              />
              <p className="text-xs text-gray-400">We sent a code to {formatUSPhoneNumber(phoneNumberInput) || phoneNumberInput}</p>
            </div>
            <Button type="submit" className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white" disabled={loading || otp.length !== 4}>
              {loading ? 'Verifying...' : 'Verify & Login'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}