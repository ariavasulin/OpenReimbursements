"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@/lib/types';
import UserManagementDashboard from "@/components/user-management-dashboard";

export default function UsersPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Create AbortController for this effect
    const abortController = new AbortController();
    let isCancelled = false;

    const checkAuth = async () => {
      try {
        // Get current session
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        // Check if this effect was cancelled
        if (isCancelled || abortController.signal.aborted) {
          return;
        }

        if (sessionError || !session) {
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        // Get user profile
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name')
          .eq('user_id', session.user.id)
          .single();

        // Check again after async operation
        if (isCancelled || abortController.signal.aborted) {
          return;
        }

        if (profileError || !profile) {
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        if (profile.role !== 'admin') {
          if (!isCancelled) {
            router.replace(profile.role === 'employee' ? '/employee' : '/login');
          }
          return;
        }

        // Success - only update state if not cancelled
        if (!isCancelled && !abortController.signal.aborted) {
          setUser(session.user);
          setUserProfile(profile);
          setLoading(false);
        }

      } catch (err) {
        console.error('[USERS] Auth error:', err);
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
        if (!isCancelled) {
          router.replace('/login');
        }
      }
    });

    // Cleanup function
    return () => {
      isCancelled = true;
      abortController.abort();
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg">Loading User Management...</p>
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

  return <UserManagementDashboard currentUserId={user.id} onLogout={handleLogout} />;
}
