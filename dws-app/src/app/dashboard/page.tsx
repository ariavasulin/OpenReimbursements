"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import type { UserProfile } from '@/lib/types';
import ReceiptDashboard from "@/components/receipt-dashboard";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    console.log('[DASHBOARD DEBUG] Component mounted, starting auth check');

    // Create AbortController for this effect
    const abortController = new AbortController();
    let isCancelled = false;

    const checkAuth = async () => {
      try {
        console.log('[DASHBOARD DEBUG] Getting session...');
        
        // Get current session
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        // Check if this effect was cancelled
        if (isCancelled || abortController.signal.aborted) {
          console.log('[DASHBOARD DEBUG] Auth check cancelled');
          return;
        }

        if (sessionError || !session) {
          console.log('[DASHBOARD DEBUG] No valid session, redirecting to login');
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        console.log('[DASHBOARD DEBUG] Session found, fetching profile');
        
        // Get user profile
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name')
          .eq('user_id', session.user.id)
          .single();

        // Check again after async operation
        if (isCancelled || abortController.signal.aborted) {
          console.log('[DASHBOARD DEBUG] Auth check cancelled after profile fetch');
          return;
        }

        if (profileError || !profile) {
          console.error('[DASHBOARD DEBUG] Profile error details:', {
            error: profileError,
            code: profileError?.code,
            message: profileError?.message,
            details: profileError?.details,
            hint: profileError?.hint,
            userId: session.user.id,
            hasProfile: !!profile
          });
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        if (profile.role !== 'admin') {
          console.log('[DASHBOARD DEBUG] User is not admin, redirecting');
          if (!isCancelled) {
            router.replace(profile.role === 'employee' ? '/employee' : '/login');
          }
          return;
        }

        // Success - only update state if not cancelled
        if (!isCancelled && !abortController.signal.aborted) {
          console.log('[DASHBOARD DEBUG] Auth successful, updating state');
          setUser(session.user);
          setUserProfile(profile);
          setLoading(false);
        }

      } catch (err) {
        console.error('[DASHBOARD DEBUG] Auth error:', err);
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
        console.log('[DASHBOARD DEBUG] User signed out');
        if (!isCancelled) {
          router.replace('/login');
        }
      }
    });

    // Cleanup function
    return () => {
      console.log('[DASHBOARD DEBUG] Cleaning up auth effect');
      isCancelled = true;
      abortController.abort();
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    console.log('[DASHBOARD DEBUG] Logging out');
    await supabase.auth.signOut();
  };

  console.log('[DASHBOARD DEBUG] Render - loading:', loading, 'user:', !!user, 'profile:', !!userProfile);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg">Loading dashboard...</p>
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

  return <ReceiptDashboard onLogout={handleLogout} />;
}
