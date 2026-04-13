"use client";

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ReceiptUploader from '@/components/receipt-uploader';
import EmployeeReceiptTable from '@/components/employee-receipt-table';
import type { Receipt, UserProfile } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Toaster as SonnerToaster } from 'sonner';

export default function EmployeePage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptsError, setReceiptsError] = useState<string | null>(null);
  
  const mountedRef = useRef(true);
  const authCheckCompleteRef = useRef(false);
  const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchReceipts = async () => {
    if (!user || !userProfile || userProfile.role !== 'employee') {
      setReceiptsLoading(false);
      return;
    }

    setReceiptsLoading(true);
    setReceiptsError(null);
    try {
      const response = await fetch('/api/receipts');

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch (e) {
          errorData = { error: `API request failed with status ${response.status}: ${response.statusText}` };
        }
        throw new Error(errorData.error || `Failed to fetch receipts (status ${response.status})`);
      }
      
      const data = await response.json();

      if (data.success && data.receipts) {
        setReceipts(data.receipts);
      } else {
        throw new Error(data.error || 'Failed to parse receipts data or success was false');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unknown error occurred during fetch";
      setReceiptsError(message);
    } finally {
      setReceiptsLoading(false);
    }
  };

  useEffect(() => {
    if (user && userProfile && userProfile.role === 'employee') {
      fetchReceipts();
    }
  }, [user, userProfile]);


  const handleReceiptAdded = () => {
    fetchReceipts();
  };

  const handleReceiptUpdated = () => {
    fetchReceipts();
  };

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
          setReceipts([]);
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
        {!receiptsLoading && !receiptsError && <EmployeeReceiptTable receipts={receipts} onReceiptUpdated={handleReceiptUpdated} />}
      
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