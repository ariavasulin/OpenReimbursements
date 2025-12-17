// src/app/employee/page.tsx
"use client";

import React, { useState, useEffect, useRef } from 'react'; // Added useRef
import Image from 'next/image'; // Added Image
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import ReceiptUploader from '@/components/receipt-uploader'; // Added
import EmployeeReceiptTable from '@/components/employee-receipt-table'; // Changed to employee-specific table
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
  
  // Add refs to track component state and prevent race conditions
  const mountedRef = useRef(true);
  const authCheckCompleteRef = useRef(false);
  const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchReceipts = async () => {
    console.log("EMPLOYEE_PAGE: fetchReceipts called. User set:", !!user, "Profile set:", !!userProfile, "Role:", userProfile?.role);
    if (!user || !userProfile || userProfile.role !== 'employee') {
      console.log("EMPLOYEE_PAGE: fetchReceipts - Pre-conditions not met. Not fetching.");
      setReceiptsLoading(false);
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

  const handleReceiptUpdated = (updatedReceipt: Receipt) => {
    // Re-fetch receipts to ensure the list is up-to-date
    fetchReceipts();
  };

  // Main authentication and profile fetching logic
  useEffect(() => {
    console.log("EMPLOYEE_PAGE: Main auth/profile useEffect triggered.");
    
    // Set loading timeout to prevent infinite loading
    loadingTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current && loading && !authCheckCompleteRef.current) {
        console.error("EMPLOYEE_PAGE: Loading timeout reached, forcing redirect to login");
        setLoading(false);
        router.replace('/login');
      }
    }, 10000); // 10 second timeout

    const protectPageAndFetchProfile = async () => {
      console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Setting main loading to true.");
      if (!mountedRef.current) return;
      
      setLoading(true);
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        if (!mountedRef.current) return; // Check if component is still mounted
        
        if (sessionError) {
          console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Session error:", sessionError);
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
        if (!session) {
          console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - No session, redirecting to login.");
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
        
        console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Session found, setting user.");
        setUser(session.user);

        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('user_id, role, full_name, preferred_name, employee_id_internal')
          .eq('user_id', session.user.id)
          .single();

        if (!mountedRef.current) return;

        if (profileError) {
          console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Error fetching user profile:", {
            error: profileError,
            code: profileError?.code,
            message: profileError?.message,
            details: profileError?.details,
            hint: profileError?.hint,
            userId: session.user.id
          });
          
          // If it's a "No rows found" error, the profile might not exist
          if (profileError.code === 'PGRST116') {
            console.log("EMPLOYEE_PAGE: Profile not found, creating default profile");
            // Try to create a default employee profile
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
              console.error("EMPLOYEE_PAGE: Failed to create profile:", insertError);
              authCheckCompleteRef.current = true;
              setLoading(false);
              router.replace('/login');
              return;
            } else {
              console.log("EMPLOYEE_PAGE: Created new profile:", newProfile);
              setUserProfile(newProfile);
              authCheckCompleteRef.current = true;
              setLoading(false);
              return;
            }
          }
          
          authCheckCompleteRef.current = true;
          setLoading(false);
          // On profile error, stay on page but don't set profile - let user try to refresh
          return;
        }

        if (profile) {
          console.log("EMPLOYEE_PAGE: protectPageAndFetchProfile - Profile found, setting userProfile.", profile);
          setUserProfile(profile);
          if (profile.role !== 'employee') {
            console.log(`EMPLOYEE_PAGE: protectPageAndFetchProfile - User role is ${profile.role}, redirecting to dashboard.`);
            authCheckCompleteRef.current = true;
            setLoading(false);
            router.replace('/dashboard');
            return;
          }
          // Successfully loaded - clear loading state
          authCheckCompleteRef.current = true;
          setLoading(false);
        } else {
          console.warn("EMPLOYEE_PAGE: protectPageAndFetchProfile - User profile not found for user_id:", session.user.id);
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
          return;
        }
      } catch (err) {
        console.error("EMPLOYEE_PAGE: protectPageAndFetchProfile - Critical error during page data fetch:", err);
        if (mountedRef.current) {
          authCheckCompleteRef.current = true;
          setLoading(false);
          router.replace('/login');
        }
      }
    };

    protectPageAndFetchProfile();

    // Simplified auth state change listener - only handle sign out
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log("EMPLOYEE_PAGE: onAuthStateChange event:", event, "session:", !!session);
        
        if (!mountedRef.current) return;
        
        // Only handle sign out events - let initial auth check handle the rest
        if (event === 'SIGNED_OUT' || !session) {
          console.log("EMPLOYEE_PAGE: User signed out, cleaning up and redirecting");
          setUser(null);
          setUserProfile(null);
          setReceipts([]);
          router.replace('/login');
        }
        // Remove the complex session handling that was causing race conditions
        // The initial protectPageAndFetchProfile handles all the session validation
      }
    );

    return () => {
      console.log("EMPLOYEE_PAGE: Cleaning up auth useEffect");
      mountedRef.current = false;
      authCheckCompleteRef.current = false;
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
      }
      authListener?.subscription?.unsubscribe();
    };
  }, [router]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
      }
    };
  }, []);

  const handleLogout = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    // onAuthStateChange will handle redirect to /login
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

  // If user is confirmed employee
  return (
    <main className="min-h-screen bg-[#222222] text-white px-4 py-8">
      <SonnerToaster richColors theme="dark" />
      
      {/* Header section */}
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
      
      {/* Main content area - constrained width for better readability */}
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