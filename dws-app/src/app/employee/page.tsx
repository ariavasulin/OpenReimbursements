// src/app/employee/page.tsx
"use client";

import React, { useState, useEffect } from 'react'; // Added useState
import Image from 'next/image'; // Added Image
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ReceiptUploader from '@/components/receipt-uploader'; // Added
import ReceiptTable from '@/components/receipt-table';     // Added
import type { Receipt, UserProfile } from '@/lib/types';        // Added Receipt type
import { Button } from '@/components/ui/button';          // For logout button styling
import { Toaster as SonnerToaster } from 'sonner';        // For toasts from uploader

export default function EmployeePage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null); // Kept from original
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false); // Initialize to false, set true only when actively fetching
  const [receiptsError, setReceiptsError] = useState<string | null>(null);

  const fetchReceipts = async () => {
    console.log("EMPLOYEE_PAGE: fetchReceipts called. User set:", !!user, "Profile set:", !!userProfile, "Role:", userProfile?.role);
    if (!user || !userProfile || userProfile.role !== 'employee') {
      console.log("EMPLOYEE_PAGE: fetchReceipts - Pre-conditions not met. Not fetching.");
      setReceiptsLoading(false); // Ensure it's false if we bail early
      return;
    }

    console.log("EMPLOYEE_PAGE: fetchReceipts - Setting receiptsLoading to true.");
    setReceiptsLoading(true);
    setReceiptsError(null);
    try {
      console.log("fetchReceipts: Calling /api/receipts");
      const response = await fetch('/api/receipts');
      console.log("fetchReceipts: Response status:", response.status);

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
          console.error("fetchReceipts: API error response:", errorData);
        } catch (e) {
          console.error("fetchReceipts: Could not parse error JSON from API. Status text:", response.statusText);
          errorData = { error: `API request failed with status ${response.status}: ${response.statusText}` };
        }
        throw new Error(errorData.error || `Failed to fetch receipts (status ${response.status})`);
      }
      
      const data = await response.json();
      console.log("fetchReceipts: API success response data:", data);
      console.log("fetchReceipts: Parsed receipts from API:", JSON.stringify(data.receipts, null, 2)); // Added detailed log

      if (data.success && data.receipts) {
        setReceipts(data.receipts);
        console.log("fetchReceipts: Receipts state updated.");
      } else {
        console.error("fetchReceipts: API response success was false or receipts missing.", data);
        throw new Error(data.error || 'Failed to parse receipts data or success was false');
      }
    } catch (error) {
      console.error("EMPLOYEE_PAGE: fetchReceipts - Caught error during fetch:", error);
      const message = error instanceof Error ? error.message : "An unknown error occurred during fetch";
      setReceiptsError(message);
    } finally {
      console.log("EMPLOYEE_PAGE: fetchReceipts - Setting receiptsLoading to false in finally.");
      setReceiptsLoading(false);
    }
  };

  // useEffect for fetching receipts, dependent on user and userProfile
  useEffect(() => {
    if (user && userProfile && userProfile.role === 'employee') {
      fetchReceipts();
    }
  }, [user, userProfile]); // Re-run when user or userProfile changes


  const handleReceiptAdded = (newReceipt: Receipt) => {
    // Re-fetch receipts to ensure the list is up-to-date
    fetchReceipts();
  };

  // useEffect for initial auth check and profile fetching
  useEffect(() => {
    console.log("EMPLOYEE_PAGE: Main auth/profile useEffect triggered.");
    const protectPageAndFetchProfile = async () => {
      console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Setting main loading to true.");
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        if (sessionError) {
          console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Session error:", sessionError);
          setLoading(false); // Set loading false before redirect
          router.replace('/login');
          return;
        }
        if (!session) {
          console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - No session, redirecting to login.");
          setLoading(false); // Set loading false before redirect
          router.replace('/login');
          return;
        }
        console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Session found, setting user.");
        setUser(session.user);

        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name, employee_id_internal')
          .eq('user_id', session.user.id)
          .single();

        if (profileError) {
          console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Error fetching user profile:", profileError);
          setLoading(false); // Set loading false on error
          return;
        }

        if (profile) {
          console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Profile found, setting userProfile.", profile);
          setUserProfile(profile);
          if (profile.role !== 'employee') {
            console.log(`EMPLOYEE_PAGE: protectPageAndFetchProfile - User role is ${profile.role}, redirecting to dashboard.`);
            setLoading(false); // Set loading false before redirect
            router.replace('/dashboard');
            return;
          }
        } else {
          console.warn("EMPLOYEE_PAGE: protectPageAndFetchProfile - User profile not found for user_id:", session.user.id);
          setLoading(false); // Set loading false before redirect
          router.replace('/login');
          return;
        }
      } catch (err) {
        console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Critical error during page data fetch:", err);
        setLoading(false); // Set loading false on catch
        router.replace('/login');
      } finally {
        // This finally might still run after a redirect has been initiated,
        // but ensuring setLoading(false) before router.replace is more robust.
        console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - In finally block, ensuring loading is false.");
        setLoading(false);
      }
    };

    protectPageAndFetchProfile();

    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log("EMPLOYEE_PAGE: onAuthStateChange event:", event, "session:", !!session);
        if (event === 'SIGNED_OUT' || !session) {
          setUser(null);
          setUserProfile(null);
          setReceipts([]);
          router.replace('/login');
        } else if (session && session.user) { // Ensure session.user exists
          console.log("EMPLOYEE_PAGE: onAuthStateChange - Session exists, updating user. User ID:", session.user.id);
          setUser(session.user);
          // Fetch profile again as user might have changed or to confirm role
          // No need to set main `loading` here, as this is a background update.
          // The receipts useEffect will react to userProfile changes.
          try {
            const { data: profile, error: profileError } = await supabase
              .from('user_profiles')
              .select('user_id, role, full_name, employee_id_internal')
              .eq('user_id', session.user.id) // Use session.user.id directly
              .single();
            
            if (profileError) {
              console.error("EMPLOYEE_PAGE: onAuthStateChange - Error fetching profile:", profileError);
              setUserProfile(null);
            } else if (profile) {
              console.log("EMPLOYEE_PAGE: onAuthStateChange - Profile fetched/re-fetched:", profile);
              setUserProfile(profile);
              if (profile.role !== 'employee') {
                router.replace('/dashboard');
              }
            } else {
               console.warn("EMPLOYEE_PAGE: onAuthStateChange - Profile not found for user_id:", session.user.id);
               setUserProfile(null);
            }
          } catch (err) {
            console.error("EMPLOYEE_PAGE: onAuthStateChange - Critical error in profile fetch:", err);
            setUserProfile(null);
          }
        } else if (session && !session.user) {
            // This case might happen if session exists but user object is null (e.g. during token refresh)
            console.log("EMPLOYEE_PAGE: onAuthStateChange - Session exists but session.user is null. Waiting for user update.");
        }
      }
    );

    return () => {
      authListener?.subscription?.unsubscribe();
    };
  }, [router]); // Keep router as a dependency for router.replace

  const handleLogout = async () => {
    setLoading(true); // Optional: show loading state on logout button
    await supabase.auth.signOut();
    // onAuthStateChange will handle redirect to /login
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen bg-[#222222] text-white"><p>Loading...</p></div>;
  }

  if (!user || !userProfile || userProfile.role !== 'employee') {
    // This should ideally be handled by the redirects in useEffect,
    // but as a fallback or if the role check fails after initial load.
    // The useEffect should redirect before this is ever rendered.
    return <div className="flex items-center justify-center min-h-screen bg-[#222222] text-white"><p>Access denied or redirecting...</p></div>;
  }

  // If user is confirmed employee
  return (
    <main className="container max-w-4xl mx-auto p-4 space-y-6 bg-[#222222] text-white min-h-screen">
      <SonnerToaster richColors theme="dark" />
      <div className="flex flex-col items-center justify-center pt-6 pb-2">
        <Image
          src="/images/logo.png" // Assuming this is the correct path from dws-app/public
          alt="DW Logo"
          width={200}
          height={200}
          priority
          className="h-auto w-32 md:w-40 object-contain mb-2" // Adjusted size
        />
        <p className="text-lg text-gray-300">Welcome, {userProfile.full_name || user.email || 'Employee'}!</p>
      </div>
      
      <ReceiptUploader onReceiptAdded={handleReceiptAdded} />
      
      {receiptsLoading && <p className="text-center">Loading receipts...</p>}
      {receiptsError && <p className="text-center text-red-500">Error loading receipts: {receiptsError}</p>}
      {!receiptsLoading && !receiptsError && <ReceiptTable receipts={receipts} />}
    
      <div className="mt-8 text-center">
        <Button
          variant="outline"
          onClick={handleLogout}
          className="border-red-500 text-red-500 hover:bg-red-500 hover:text-white"
        >
          Logout
        </Button>
      </div>
    </main>
  );
}