"use client";

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ReceiptUploader from '@/components/receipt-uploader';
import EmployeeReceiptTable from '@/components/employee-receipt-table';
import LoadMoreButton from '@/components/photos/load-more-button';
import type { Receipt, UserProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Toaster as SonnerToaster } from 'sonner';

const receiptsKeys = { list: () => ['receipts', 'mine'] as const };

type ReceiptsPage = { receipts: Receipt[]; nextCursor: string | null };

export default function EmployeePage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(true);
  const authCheckCompleteRef = useRef(false);
  const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Receipts live in the react-query cache (5-minute staleTime from the app's
  // QueryProvider), so remounting this page within that window renders from
  // cache instead of refetching the whole history — the endpoint is also
  // keyset-paginated now, 50 rows per page.
  const queryClient = useQueryClient();
  const receiptsEnabled = Boolean(user && userProfile?.role === 'employee');

  const {
    data: receiptsData,
    isLoading: receiptsLoading,
    error: receiptsQueryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: receiptsKeys.list(),
    enabled: receiptsEnabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ReceiptsPage> => {
      const search = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      const response = await fetch(`/api/receipts${search}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed to fetch receipts (status ${response.status})`);
      }
      return response.json();
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const receipts = receiptsData?.pages.flatMap((page) => page.receipts) ?? [];
  const receiptsError =
    receiptsQueryError instanceof Error ? receiptsQueryError.message : null;

  const invalidateReceipts = () =>
    queryClient.invalidateQueries({ queryKey: receiptsKeys.list() });

  const handleReceiptAdded = invalidateReceipts;
  const handleReceiptUpdated = invalidateReceipts;

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
          queryClient.removeQueries({ queryKey: receiptsKeys.list() });
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
        <ReceiptUploader onReceiptAdded={handleReceiptAdded} />
        
        {receiptsLoading && <p className="text-center">Loading receipts...</p>}
        {receiptsError && <p className="text-center text-red-500">Error loading receipts: {receiptsError}</p>}
        {!receiptsLoading && !receiptsError && (
          <>
            <EmployeeReceiptTable receipts={receipts} onReceiptUpdated={handleReceiptUpdated} />
            {hasNextPage && (
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