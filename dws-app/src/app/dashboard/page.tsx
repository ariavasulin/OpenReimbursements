"use client";

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@/lib/types';
import ReceiptDashboard from "@/components/receipt-dashboard";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    let isCancelled = false;

    const checkAuth = async () => {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (isCancelled || abortController.signal.aborted) {
          return;
        }

        if (sessionError || !session) {
          if (!isCancelled) {
            router.replace('/login');
          }
          return;
        }

        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name')
          .eq('user_id', session.user.id)
          .single();

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

        if (!isCancelled && !abortController.signal.aborted) {
          setUser(session.user);
          setUserProfile(profile);
          setLoading(false);
        }

      } catch (err) {
        if (!isCancelled && !abortController.signal.aborted) {
          setError('Authentication failed');
          setLoading(false);
        }
      }
    };

    checkAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        if (!isCancelled) {
          router.replace('/login');
        }
      }
    });

    return () => {
      isCancelled = true;
      abortController.abort();
      authListener?.subscription?.unsubscribe();
    };
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

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
