// src/app/dashboard/page.tsx
"use client";

import React, { useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = React.useState<any>(null); // Consider defining a User type
  const [loading, setLoading] = React.useState(true);

  useEffect(() => {
    console.log('[Dashboard] useEffect triggered');

    const fetchUserAndCheckSession = async () => {
      console.log('[Dashboard] fetchUserAndCheckSession called');
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      console.log('[Dashboard] getSession result:', { session, sessionError });

      if (sessionError) {
        console.error('[Dashboard] getSession error:', sessionError);
      }
      
      if (!session) {
        console.log('[Dashboard] No session found by getSession, redirecting to login.');
        router.replace('/login');
        setLoading(false); // Ensure loading stops if redirecting early
        return;
      }
      
      console.log('[Dashboard] Session found by getSession. User:', session.user);
      setUser(session.user);
      setLoading(false);
    };

    fetchUserAndCheckSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        console.log('[Dashboard] onAuthStateChange event:', event, 'session:', session);
        if (event === 'SIGNED_OUT' || !session) {
          console.log('[Dashboard] onAuthStateChange: SIGNED_OUT or no session, redirecting to login.');
          router.replace('/login');
        } else if (session) {
          console.log('[Dashboard] onAuthStateChange: Session updated/received. User:', session.user);
          setUser(session.user);
        }
      }
    );

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('Error logging out:', error);
      // Optionally show an error message to the user
    }
    // onAuthStateChange will handle redirect to /login
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg">Loading dashboard...</p>
      </div>
    );
  }

  if (!user) {
    // This case should ideally be handled by the redirect in useEffect,
    // but as a fallback:
    return (
        <div className="flex flex-col items-center justify-center min-h-screen">
            <p className="text-lg mb-4">No active session. Redirecting to login...</p>
        </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      <div className="w-full max-w-2xl p-8 space-y-6 bg-white rounded-lg shadow-md text-center">
        <h1 className="text-3xl font-bold text-gray-800">Welcome to the Dashboard!</h1>
        <p className="text-gray-600">You are successfully logged in.</p>
        {user && (
          <div className="mt-4 p-4 bg-indigo-50 rounded-md">
            <p className="text-sm text-gray-700">
              <strong>User ID:</strong> {user.id}
            </p>
            {user.phone && (
              <p className="text-sm text-gray-700">
                <strong>Phone:</strong> {user.phone}
              </p>
            )}
            {user.email && (
              <p className="text-sm text-gray-700">
                <strong>Email:</strong> {user.email}
              </p>
            )}
          </div>
        )}
        <button
          onClick={handleLogout}
          disabled={loading}
          className="mt-6 w-full sm:w-auto inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
        >
          {loading ? 'Logging out...' : 'Logout'}
        </button>
      </div>
    </div>
  );
}