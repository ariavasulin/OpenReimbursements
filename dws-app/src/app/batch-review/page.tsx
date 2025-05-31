"use client";

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@/lib/types';
import BatchReviewDashboard from "@/components/batch-review-dashboard";

export default function BatchReviewPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    console.log('[BATCH-REVIEW DEBUG] Component mounted, starting auth check');

    // Create AbortController for this effect
    const abortController = new AbortController();
    let isCancelled = false;

    const checkAuth = async () => {
      try {
        console.log('[BATCH-REVIEW DEBUG] Getting session...');
        
        // Get current session
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        // Check if this effect was cancelled
        if (isCancelled || abortController.signal.aborted) {
          console.log('[BATCH-REVIEW DEBUG] Auth check cancelled');
          return;
        }

        if (sessionError || !session) {
          console.log('[BATCH-REVIEW DEBUG] No valid session, redirecting to login');
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        console.log('[BATCH-REVIEW DEBUG] Session found, fetching profile');
        
        // Get user profile
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name')
          .eq('user_id', session.user.id)
          .single();

        // Check again after async operation
        if (isCancelled || abortController.signal.aborted) {
          console.log('[BATCH-REVIEW DEBUG] Auth check cancelled after profile fetch');
          return;
        }

        if (profileError || !profile) {
          console.log('[BATCH-REVIEW DEBUG] Profile error, redirecting to login');
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        if (profile.role !== 'admin') {
          console.log('[BATCH-REVIEW DEBUG] User is not admin, redirecting');
          if (!isCancelled) {
            router.replace(profile.role === 'employee' ? '/employee' : '/login');
          }
          return;
        }

        // Success - only update state if not cancelled
        if (!isCancelled && !abortController.signal.aborted) {
          console.log('[BATCH-REVIEW DEBUG] Auth successful, updating state');
          setUser(session.user);
          setUserProfile(profile);
          setLoading(false);
        }

      } catch (err) {
        console.error('[BATCH-REVIEW DEBUG] Auth error:', err);
        if (!isCancelled && !abortController.signal.aborted) {
          setError('Authentication failed');
          setLoading(false);
        }
      }
    };

    checkAuth();

    // Auth state listener for sign out only
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        console.log('[BATCH-REVIEW DEBUG] User signed out');
        if (!isCancelled) {
          router.replace('/login');
        }
      }
    });

    // Cleanup function
    return () => {
      console.log('[BATCH-REVIEW DEBUG] Cleaning up auth effect');
      isCancelled = true;
      abortController.abort();
      authListener?.subscription?.unsubscribe();
    };
  }, []); // Empty dependency array

  const handleLogout = async () => {
    console.log('[BATCH-REVIEW DEBUG] Logging out');
    await supabase.auth.signOut();
  };

  console.log('[BATCH-REVIEW DEBUG] Render - loading:', loading, 'user:', !!user, 'profile:', !!userProfile);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg">Loading Batch Review...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg text-red-400">Error: {error}</p>
        <button 
          onClick={() => window.location.reload()} 
          className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!user || !userProfile || userProfile.role !== 'admin') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg mb-4">Access Denied</p>
      </div>
    );
  }

  return <BatchReviewDashboard onLogout={handleLogout} />;
}
