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
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        router.replace('/dashboard');
      } else {
        router.replace('/login');
      }
      // setLoading(false); // Setting loading to false might cause a flash if redirect is too fast
    };

    checkSessionAndRedirect();

    // Optional: Listen for auth changes if the user might log in/out
    // on another tab while this page is somehow still active,
    // though direct navigation or getSession on load is usually sufficient for a root redirector.
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session) {
          router.replace('/dashboard');
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
