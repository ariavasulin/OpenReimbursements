"use client";

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@/lib/types';
import BatchReviewDashboard from "@/components/batch-review-dashboard";

export default function BatchReviewPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('[Batch Review Dashboard] useEffect triggered');

    const fetchUserAndCheckSession = async () => {
      console.log('[Batch Review Dashboard] fetchUserAndCheckSession called');
      setLoading(true);
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      console.log('[Batch Review Dashboard] getSession result:', { session, sessionError });

      if (sessionError) {
        console.error('[Batch Review Dashboard] getSession error:', sessionError);
        router.replace('/login');
        setLoading(false);
        return;
      }

      if (!session) {
        console.log('[Batch Review Dashboard] No session found by getSession, redirecting to login.');
        router.replace('/login');
        setLoading(false);
        return;
      }

      setUser(session.user);
      console.log('[Batch Review Dashboard] Session found. User ID:', session.user.id);

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('user_id, role, full_name')
        .eq('user_id', session.user.id)
        .single();

      if (profileError) {
        console.error("[Batch Review Dashboard] Error fetching user profile:", profileError);
        setLoading(false); // Ensure loading is false before redirect
        router.replace('/login');
        return;
      }

      if (profile) {
        console.log('[Batch Review Dashboard] Profile fetched:', profile);
        setUserProfile(profile);
        if (profile.role !== 'admin') {
          console.log(`[Batch Review Dashboard] User role is ${profile.role}, redirecting.`);
          setLoading(false); // Ensure loading is false before redirect
          router.replace(profile.role === 'employee' ? '/employee' : '/login');
        } else {
          // Only set loading to false if admin
          setLoading(false);
        }
      } else {
        console.warn("[Batch Review Dashboard] User profile not found for user_id:", session.user.id);
        setLoading(false); // Ensure loading is false before redirect
        router.replace('/login');
      }
    };

    fetchUserAndCheckSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('[Batch Review Dashboard] onAuthStateChange event:', event, 'session:', session);
        if (event === 'SIGNED_OUT' || !session) {
          console.log('[Batch Review Dashboard] onAuthStateChange: SIGNED_OUT or no session, redirecting to login.');
          setUser(null);
          setUserProfile(null);
          router.replace('/login');
        } else if (session && session.user) {
          setUser(session.user);
          const { data: profile, error: profileError } = await supabase
            .from('user_profiles')
            .select('user_id, role, full_name')
            .eq('user_id', session.user.id)
            .single();

          if (profile && !profileError) {
            setUserProfile(profile);
            if (profile.role !== 'admin') {
              router.replace(profile.role === 'employee' ? '/employee' : '/login');
            }
          } else if (profileError) {
             console.error("[Batch Review Dashboard] Error fetching profile on auth change:", profileError);
             router.replace('/login');
          } else {
            console.warn("[Batch Review Dashboard] Profile not found on auth change for user_id:", session.user.id);
            router.replace('/login');
          }
        } else if (session && !session.user && event !== 'INITIAL_SESSION') {
            console.log('[Batch Review Dashboard] onAuthStateChange: Session exists but no user, redirecting to login.');
            router.replace('/login');
        }
      }
    );

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    const prevLoading = loading;
    setLoading(true);
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('Error logging out:', error);
      setLoading(prevLoading);
    }
    // onAuthStateChange will handle redirect to /login
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
        <p className="text-lg">Loading Batch Review...</p>
      </div>
    );
  }

  if (!user || !userProfile || userProfile.role !== 'admin') {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-[#2e2e2e] text-white">
            <p className="text-lg mb-4">Access Denied or Redirecting to Login...</p>
        </div>
    );
  }

  return (
    <>
      <BatchReviewDashboard />
      {/* Basic logout button for now, can be moved to a shared header later */}
      {/* The BatchReviewDashboard itself has a "Back to Dashboard" link, so a logout button here might be redundant if main dashboard has it. */}
      {/* For consistency with how dashboard/page.tsx was handled, adding it here too. */}
      <div className="absolute top-4 right-4 z-50"> {/* Ensure z-index if it overlaps with dashboard content */}
        <button
          onClick={handleLogout}
          className="py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[var(--destructive)] hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--destructive)]"
        >
          Logout
        </button>
      </div>
    </>
  );
}
