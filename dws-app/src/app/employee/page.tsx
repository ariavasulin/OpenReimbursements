"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ReceiptUploader from '@/components/receipt-uploader';
import EmployeeReceiptTable from '@/components/employee-receipt-table';
import LoadMoreButton from '@/components/photos/load-more-button';
import StatusLine from '@/components/photos/status-line';
import { useMyReceipts, useRefreshMyReceipts, type ReceiptStatusFilter } from '@/hooks/use-receipts';
import type { UserProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Toaster as SonnerToaster } from 'sonner';

export default function EmployeePage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<ReceiptStatusFilter>('all');

  const mountedRef = useRef(true);
  const authCheckCompleteRef = useRef(false);
  const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    data: receiptsData,
    isLoading: receiptsLoading,
    isPlaceholderData: receiptsArePlaceholder,
    error: receiptsQueryError,
    refetch: refetchReceipts,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMyReceipts({
    userId: user?.id,
    status: statusFilter,
    enabled: Boolean(user && userProfile?.role === 'employee'),
  });

  const receipts = useMemo(
    () => receiptsData?.pages.flatMap((page) => page.receipts) ?? [],
    [receiptsData]
  );
  const receiptsError =
    receiptsQueryError instanceof Error ? receiptsQueryError.message : null;

  const refreshReceipts = useRefreshMyReceipts(user?.id);

  useEffect(() => {
    loadingTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && loading && !authCheckCompleteRef.current) {
        setLoading(false);
        router.replace('/login');
      }
    }, 10000);

    const protectPageAndFetchProfile = async () => {
      if (!mountedRef.current) return;
      
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        if (!mountedRef.current) return;
        
        if (sessionError) {
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
        if (!session) {
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
        
        setUser(session.user);

        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name, preferred_name, employee_id_internal')
          .eq('user_id', session.user.id)
          .single();

        if (!mountedRef.current) return;

        if (profileError) {
          // "No rows found" — profile doesn't exist yet, create a default
          if (profileError.code === 'PGRST116') {
            const { data: newProfile, error: insertError } = await supabase
              .from('user_profiles')
              .insert({
                user_id: session.user.id,
                role: 'employee',
                full_name: session.user.phone || 'Employee',
                preferred_name: null,
                employee_id_internal: null
              })
              .select()
              .single();
            
            if (insertError) {
              authCheckCompleteRef.current = true;
              setLoading(false);
              router.replace('/login');
              return;
            } else {
              setUserProfile(newProfile);
              authCheckCompleteRef.current = true;
              setLoading(false);
              return;
            }
          }
          
          authCheckCompleteRef.current = true;
          setLoading(false);
          // Stay on page so user can retry rather than redirect on transient errors
          return;
        }

        if (profile) {
          setUserProfile(profile);
          if (profile.role !== 'employee') {
            authCheckCompleteRef.current = true;
            setLoading(false);
            router.replace('/dashboard');
            return;
          }
          authCheckCompleteRef.current = true;
          setLoading(false);
        } else {
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
      } catch (err) {
        if (mountedRef.current) {
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
        }
      }
    };

    protectPageAndFetchProfile();

    // Only handle sign out — initial auth check handles session validation
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mountedRef.current) return;

        if (event === 'SIGNED_OUT' || !session) {
          setUser(null);
          setUserProfile(null);
          // Cache clearing is AuthIdentityBoundary's job (query-provider.tsx);
          // this listener dies with the page.
          router.replace('/login');
        }
      }
    );

    return () => {
      mountedRef.current = false;
      authCheckCompleteRef.current = false;
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
      }
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  const handleLogout = async () => {
    setLoading(true);
    await supabase.auth.signOut();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#222222] text-white">
        <div className="text-center">
          <p className="text-lg mb-2">Loading...</p>
          <p className="text-sm text-gray-400">Verifying authentication</p>
        </div>
      </div>
    );
  }

  if (!user || !userProfile || userProfile.role !== 'employee') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#222222] text-white">
        <div className="text-center">
          <p className="text-lg mb-2">Access denied or redirecting...</p>
          <p className="text-sm text-gray-400">Please wait while we redirect you</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#222222] text-white px-4 py-8">
      <SonnerToaster richColors theme="dark" />
      
      <div className="flex flex-col items-center justify-center pb-8">
        <Image
          src="/images/logo.png"
          alt="DW Logo"
          width={200}
          height={200}
          priority
          className="h-auto w-32 md:w-40 object-contain mb-4"
        />
        <p className="text-lg text-gray-300">Welcome, {(userProfile?.preferred_name
            || userProfile?.full_name
            || user?.user_metadata?.preferred_name
            || user?.user_metadata?.full_name
            || user?.email
            || 'Employee')}!</p>
      </div>
      
      <div className="max-w-4xl mx-auto space-y-6">
        <ReceiptUploader onReceiptAdded={refreshReceipts.afterUpload} />
        
        {receiptsLoading && <StatusLine>Loading receipts...</StatusLine>}
        {/* A failed fetch — first load or a later "Load more" — reports
            itself here, but never takes already-loaded rows off the screen. */}
        {receiptsError && (
          <div className="text-center space-y-2">
            <StatusLine error>Error loading receipts: {receiptsError}</StatusLine>
            <Button
              variant="outline"
              onClick={() => (receiptsData ? fetchNextPage() : refetchReceipts())}
              className="border-[#4e4e4e] text-white hover:bg-[#383838]"
            >
              Try again
            </Button>
          </div>
        )}
        {receiptsData && (
          <>
            <EmployeeReceiptTable
              receipts={receipts}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              onReceiptUpdated={refreshReceipts.afterEdit}
              isStale={receiptsArePlaceholder}
            />
            {hasNextPage && !receiptsError && (
              <LoadMoreButton onClick={() => fetchNextPage()} loading={isFetchingNextPage} />
            )}
          </>
        )}
      
        <div className="mt-8 text-center">
          <Button
            variant="outline"
            onClick={handleLogout}
            className="bg-red-500 border-red-500 text-white hover:bg-transparent hover:text-red-500"
          >
            Logout
          </Button>
        </div>

        <div className="mt-8 text-center">
          <a href="/photos" className="text-[#2680FC] hover:underline">
            DWS Photos
          </a>
        </div>

        <div className="mt-4 text-center">
          <a
            href="https://form.typeform.com/to/b1XfPMaK"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#2680FC] hover:underline"
          >
            Give Feedback
          </a>
        </div>
      </div>
    </main>
  );
}