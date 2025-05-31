// src/app/page.tsx
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
    // Set a timeout to prevent infinite loading
    redirectTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && loading) {
        console.error("ROOT_PAGE: Redirect timeout reached, forcing redirect to login");
        setLoading(false);
        router.replace('/login');
      }
    }, 8000); // 8 second timeout

    const checkSessionAndRedirect = async () => {
      if (!mountedRef.current) return;
      
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (!mountedRef.current) return;

        if (sessionError) {
          console.error("Error getting session in root page:", sessionError);
          setLoading(false);
          router.replace('/login');
          return;
        }

        if (session) {
          // User is logged in, fetch their role
          const { data: profile, error: profileError } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('user_id', session.user.id)
            .single();

          if (!mountedRef.current) return;

          if (profileError) {
            console.error("Error fetching user profile in root page:", profileError);
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
              console.warn("Unknown user role:", profile.role);
              router.replace('/login');
            }
          } else {
            console.warn("Profile not found for logged-in user:", session.user.id);
            router.replace('/login');
          }
        } else {
          // No session, redirect to login
          router.replace('/login');
        }
      } catch (error) {
        console.error("Critical error in root page session check:", error);
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
        
        console.log("ROOT_PAGE: Auth state change:", event);
        
        // Only handle sign out - let each page handle its own auth validation
        if (event === 'SIGNED_OUT' || !session) {
          router.replace('/login');
        }
        // Remove complex session handling to prevent race conditions with other pages
      }
    );

    return () => {
      console.log("ROOT_PAGE: Cleaning up");
      mountedRef.current = false;
      if (redirectTimeoutRef.current) {
        clearTimeout(redirectTimeoutRef.current);
      }
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (redirectTimeoutRef.current) {
        clearTimeout(redirectTimeoutRef.current);
      }
    };
  }, []);

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

  // This should not be reached if redirection is working correctly
  return null; 
}
