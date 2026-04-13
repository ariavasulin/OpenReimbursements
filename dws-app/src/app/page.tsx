"use client";

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const redirectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    redirectTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && loading) {
        setLoading(false);
        router.replace('/login');
      }
    }, 8000);

    const checkSessionAndRedirect = async () => {
      if (!mountedRef.current) return;
      
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (!mountedRef.current) return;

        if (sessionError) {
          setLoading(false);
          router.replace('/login');
          return;
        }

        if (session) {
          const { data: profile, error: profileError } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('user_id', session.user.id)
            .single();

          if (!mountedRef.current) return;

          if (profileError) {
            setLoading(false);
            router.replace('/login');
            return;
          }

          if (profile) {
            if (profile.role === 'employee') {
              router.replace('/employee');
            } else if (profile.role === 'admin') {
              router.replace('/dashboard');
            } else {
              router.replace('/login');
            }
          } else {
            router.replace('/login');
          }
        } else {
          router.replace('/login');
        }
      } catch (error) {
        if (mountedRef.current) {
          setLoading(false);
          router.replace('/login');
        }
      }
    };

    checkSessionAndRedirect();

    // Simplified auth listener - only handle sign out to avoid conflicts
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mountedRef.current) return;

        // Only handle sign out - let each page handle its own auth validation
        if (event === 'SIGNED_OUT' || !session) {
          router.replace('/login');
        }
        // Remove complex session handling to prevent race conditions with other pages
      }
    );

    return () => {
      mountedRef.current = false;
      if (redirectTimeoutRef.current) {
        clearTimeout(redirectTimeoutRef.current);
      }
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#222222] text-white">
        <div className="text-center">
          <p className="text-lg mb-2">Loading...</p>
          <p className="text-sm text-gray-400">Checking authentication</p>
        </div>
      </div>
    );
  }

  return null;
}
