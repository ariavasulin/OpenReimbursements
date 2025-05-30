// src/app/page.tsx
"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSessionAndRedirect = async () => {
      setLoading(true); // Ensure loading is true at the start of the check
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) {
        console.error("Error getting session in root page:", sessionError);
        router.replace('/login');
        setLoading(false);
        return;
      }

      if (session) {
        // User is logged in, fetch their role
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('user_id', session.user.id)
          .single();

        if (profileError) {
          console.error("Error fetching user profile in root page:", profileError);
          // Decide on fallback, e.g., to a generic dashboard or logout then login
          router.replace('/login'); // Fallback to login if profile fetch fails
          setLoading(false);
          return;
        }

        if (profile) {
          if (profile.role === 'employee') {
            router.replace('/employee');
          } else if (profile.role === 'admin') {
            router.replace('/dashboard'); // Dashboard is now for admins
          } else {
            // Unknown role, redirect to login or an error page
            console.warn("Unknown user role:", profile.role);
            router.replace('/login');
          }
        } else {
          // Profile not found for a logged-in user (should be rare due to trigger)
          console.warn("Profile not found for logged-in user:", session.user.id);
          router.replace('/login'); // Or handle as an error
        }
      } else {
        // No session, redirect to login
        router.replace('/login');
      }
      setLoading(false);
    };

    checkSessionAndRedirect();

    // onAuthStateChange will also need to perform role-based redirection
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        // No need to setLoading(true) here as checkSessionAndRedirect handles initial load
        if (session) {
          const { data: profile, error: profileError } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('user_id', session.user.id)
            .single();
          
          if (profile && !profileError) {
            if (profile.role === 'employee') {
              router.replace('/employee');
            } else if (profile.role === 'admin') {
              router.replace('/dashboard');
            } else {
              router.replace('/login');
            }
          } else {
            router.replace('/login'); // Fallback if profile fetch fails during auth change
          }
        } else {
          router.replace('/login');
        }
      }
    );

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  // Display a loading message or a blank page while redirecting
  // to avoid flashing the default Next.js content if it were still here.
  if (loading) { // Or simply return null for a blank screen during redirect
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg">Loading...</p>
      </div>
    );
  }

  // This part should ideally not be reached if redirection is working correctly.
  return null; 
}
