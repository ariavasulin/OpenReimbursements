# Project Progress Summary (DWS Receipts App)

This document summarizes the key progress made in setting up the DWS Receipts application.

## I. Core Application Setup (`dws-app`)
1.  **Next.js Project Initialization:**
    *   A new Next.js project named `dws-app` was created in the workspace root.
    *   Initialized with TypeScript, Tailwind CSS, ESLint, App Router, `src/` directory, and `@/*` import alias.
2.  **ShadCN/UI Integration:**
    *   ShadCN/UI was initialized using `npx shadcn@latest init`.
    *   Core UI components (`button`, `input`, `label`, `card`, `select`, `popover`, `calendar`, `table`, `badge`, `pagination`, `dialog`, `sonner`) were added to `dws-app/src/components/ui/`.
    *   `lucide-react` for icons was installed.
3.  **Dependency Management:**
    *   `@supabase/supabase-js` for Supabase client.
    *   `date-fns` (v3.6.0) for date utilities (resolved peer dependency with `react-day-picker`).
    *   `uuid` (and `@types/uuid`) for generating unique IDs.

## II. Authentication System
1.  **Supabase Configuration:**
    *   Environment variables for Supabase URL and Anon Key set up in `dws-app/.env.local`.
    *   Supabase client initialized in `dws-app/src/lib/supabaseClient.ts`.
2.  **OTP Login Flow (Twilio via Supabase):**
    *   Backend API routes created in `dws-app/src/app/api/auth/`:
        *   `send-otp/route.ts`: Handles requests to send OTPs using `supabase.auth.signInWithOtp()`.
        *   `verify-otp/route.ts`: Handles OTP verification using `supabase.auth.verifyOtp()`.
    *   Frontend Login Page (`dws-app/src/app/login/page.tsx`):
        *   UI styled to match the provided "receipt-login" prototype (dark theme, logo, specific input/button styles).
        *   Users can input phone number, request OTP, and submit OTP for verification.
        *   Client-side session is manually set using `supabase.auth.setSession()` after successful API verification to ensure session persistence.
        *   Error handling and loading states implemented.
3.  **User Roles & Profiles:**
    *   `user_profiles` table created in Supabase with `user_id` (FK to `auth.users`), `role` ('employee' or 'admin'), `full_name`, `employee_id_internal`.
    *   Database trigger `on_auth_user_created` and function `handle_new_user` implemented to automatically create a profile with 'employee' role for new users.
    *   RLS enabled on `user_profiles` with basic policies.
4.  **Role-Based Redirection:**
    *   Root page (`dws-app/src/app/page.tsx`) redirects authenticated users based on their role (fetched from `user_profiles`) to either `/employee` or `/dashboard` (admin).
    *   Login page (`dws-app/src/app/login/page.tsx`) redirects based on role after successful login.
    *   Placeholder Dashboard (`dws-app/src/app/dashboard/page.tsx`): Acts as the admin landing page, verifies 'admin' role.
    *   Placeholder Employee Page (`dws-app/src/app/employee/page.tsx`): Acts as the employee landing page, verifies 'employee' role. Includes a logout button.

## III. Employee Frontend Integration (Initial Scaffolding)
1.  **Employee Page Route:**
    *   Created `dws-app/src/app/employee/page.tsx`.
2.  **Component & Asset Integration:**
    *   Custom components from `Prototypes/employee-frontend/` (`ReceiptDetailsCard`, `ReceiptTable`, `ReceiptUploader`) copied to `dws-app/src/components/`.
    *   `useMobile` hook copied to `dws-app/src/hooks/`.
    *   `types.ts` (with `Receipt`, `Category`, `UserProfile`) created in `dws-app/src/lib/`.
    *   Utility functions (`formatCurrency`, `formatDate`) added to `dws-app/src/lib/utils.ts`.
    *   Logo image (`DWLogo_white+transparent.png`) assumed to be at `dws-app/public/images/logo.png` (as used by login page, prototype used a slightly different name but likely same asset).
3.  **Employee Page Content:**
    *   The JSX structure and basic client-side logic from the prototype's main page have been integrated into `dws-app/src/app/employee/page.tsx`.
    *   Includes `ReceiptUploader` and `ReceiptTable` components.
    *   Authentication protection and a logout button are implemented.
    *   `<SonnerToaster />` added for toast notifications.
    *   Initial data for receipts is an empty array; fetching from Supabase is a TODO.
    *   OCR simulation and local receipt handling logic from the prototype are present but will need to be replaced with actual backend integration.

## IV. Key Debugging & Resolutions
*   **Twilio OTP Sending:** Resolved "Invalid From Number" errors by guiding user to correctly configure Twilio Verify Service, likely involving a Messaging Service SID in Supabase Phone Auth settings.
*   **Client-Side Session Persistence:** Addressed issue where session wasn't recognized after API-based OTP verification by manually calling `supabase.auth.setSession()` on the client with tokens from the API response.
*   **Redirection Logic:** Refined `useEffect` hooks on login, root, and dashboard/employee pages to robustly handle role fetching and redirection, including using `setTimeout(..., 0)` to ensure router calls are processed effectively after state changes.
*   **TypeScript & Dependency Issues:**
    *   Resolved peer dependency conflicts with `date-fns` and `react-day-picker` by using a compatible version of `date-fns` and `--legacy-peer-deps`.
    *   Corrected various TypeScript errors related to component imports, type definitions, and hook signatures.
    *   Fixed syntax errors in `useEffect` dependency arrays and component structures.

The application is now in a state where users can log in via OTP, be routed to a role-appropriate page (basic employee page scaffolded from prototype, or admin dashboard), and log out.

## V. Receipt Upload & Viewing Functionality (Employee)
1.  **Documentation Update:**
    *   [`Docs/PRD.md`](Docs/PRD.md) updated to reflect using Supabase Storage (bucket `receipt-images`) instead of OneDrive for image storage.
2.  **Supabase Auth Library Migration:**
    *   Uninstalled deprecated `@supabase/auth-helpers-nextjs`.
    *   Installed recommended `@supabase/ssr` package (using `--legacy-peer-deps` due to existing project dependencies).
    *   Updated client-side Supabase client utility ([`dws-app/src/lib/supabaseClient.ts`](dws-app/src/lib/supabaseClient.ts)) to use `createBrowserClient` from `@supabase/ssr`.
    *   Created a new server-side Supabase client utility ([`dws-app/src/lib/supabaseServerClient.ts`](dws-app/src/lib/supabaseServerClient.ts)) using `createServerClient` and `await cookies()`.
    *   Updated existing API authentication routes ([`dws-app/src/app/api/auth/send-otp/route.ts`](dws-app/src/app/api/auth/send-otp/route.ts), [`dws-app/src/app/api/auth/verify-otp/route.ts`](dws-app/src/app/api/auth/verify-otp/route.ts)) to use the new server client utility.
3.  **Receipt Upload Implementation:**
    *   Created API route [`dws-app/src/app/api/receipts/upload/route.ts`](dws-app/src/app/api/receipts/upload/route.ts) (`POST`) to handle image file uploads to Supabase Storage bucket `receipt-images`.
        *   Uploads to a temporary path: `user_id/temp_filename.ext`.
        *   Returns the temporary path and `contentType`.
    *   Created API route [`dws-app/src/app/api/receipts/route.ts`](dws-app/src/app/api/receipts/route.ts) (`POST`) to:
        *   Receive receipt details (date, amount, category ID, notes) and the `tempFilePath`.
        *   Insert a new record into the `receipts` database table.
        *   Move the uploaded image from `tempFilePath` to a final path (`user_id/receipt_id.ext`) in Supabase Storage.
        *   Update the receipt record with the final image path.
    *   Modified frontend `ReceiptUploader` component ([`dws-app/src/components/receipt-uploader.tsx`](dws-app/src/components/receipt-uploader.tsx)) to call these two backend APIs sequentially.
    *   Created API route [`dws-app/src/app/api/categories/route.ts`](dws-app/src/app/api/categories/route.ts) (`GET`) to fetch expense categories.
    *   Modified `ReceiptDetailsCard` component ([`dws-app/src/components/receipt-details-card.tsx`](dws-app/src/components/receipt-details-card.tsx)) to:
        *   Fetch categories from the new API endpoint.
        *   Populate a dropdown for category selection (using `category_id`).
        *   Address Radix UI accessibility warning by adding `DialogHeader`, `DialogTitle`, and `DialogDescription`.
4.  **View Uploaded Receipts Implementation:**
    *   Added a `GET` handler to [`dws-app/src/app/api/receipts/route.ts`](dws-app/src/app/api/receipts/route.ts) to:
        *   Fetch receipts for the authenticated user.
        *   Generate public URLs for stored receipt images.
    *   Modified the employee page ([`dws-app/src/app/employee/page.tsx`](dws-app/src/app/employee/page.tsx)) to:
        *   Fetch receipts on load and pass them to `ReceiptTable`.
        *   Re-fetch receipts after a new one is added.
    *   Ensured `ReceiptTable` component ([`dws-app/src/components/receipt-table.tsx`](dws-app/src/components/receipt-table.tsx)) correctly displays receipt data, including dates and links to images.
5.  **Debugging & Refinements:**
    *   Resolved RLS error during storage upload by adding appropriate Storage policies (INSERT, SELECT, DELETE, UPDATE) for the `receipt-images` bucket.
    *   Fixed database check constraint violation for `receipts.status` by aligning code to use capitalized 'Pending'.
    *   Updated `Receipt` type and client-side components to consistently use `receipt_date` for date fields, resolving display issues.
    *   Addressed React hydration warning related to whitespace in `ReceiptTable`.
    *   Iteratively debugged loading state issues on the employee page, particularly for hard refreshes, by refining `useEffect` logic and state updates.

**Current Status:**
*   Employees can log in.
*   Employees can upload receipts (image + details: Date, Amount, Category, Notes).
*   Uploaded receipts are stored in Supabase Storage (`receipt-images` bucket).
*   Receipt metadata is stored in the Supabase `receipts` table.
*   Employees can view a list of their submitted receipts, including dates and links to images.
*   The date display issue and whitespace console error are resolved.

**Known Remaining Issue:**
*   The employee page ([`dws-app/src/app/employee/page.tsx`](dws-app/src/app/employee/page.tsx)) sometimes gets stuck on "Loading..." during rapid back-to-back hard refreshes. Waiting a few seconds before refreshing allows it to load correctly. This suggests a potential race condition with Supabase session initialization or `onAuthStateChange` listener during very quick refreshes. Further investigation is needed for this specific scenario.