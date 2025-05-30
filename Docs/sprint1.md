# DWS App - Sprint 1 Plan: Project Initialization & Authentication Setup

**Project Goal:** Create a new Next.js application named `dws-app` with a functional SMS OTP login page using Twilio for sending OTPs and Supabase for OTP verification and user authentication.

**Key Decisions:**
*   **Project Directory:** `dws-app` (new Next.js project)
*   **Prototype Usage:** `Prototypes/receipt-login/` will be used for UI/UX reference only.
*   **OTP Flow:**
    1.  User enters phone number on the frontend.
    2.  Frontend calls a Next.js API route (`/api/auth/send-otp`).
    3.  `send-otp` API route calls `supabase.auth.signInWithOtp({ phone })`. Supabase (configured with Twilio Verify) handles sending the OTP.
    4.  User enters the received OTP on the frontend.
    5.  Frontend calls another Next.js API route (`/api/auth/verify-otp`) with the phone number and OTP.
    6.  `verify-otp` API route calls `supabase.auth.verifyOtp({ phone, token, type: 'sms' })`. Supabase handles the verification.
    7.  If successful, a session is established, and the user is logged in.
*   **Supabase Project ID:** `qebbmojnqzwwdpkhuyyd`
*   **Twilio Credentials:** Placeholders will be used initially (Supabase handles direct Twilio interaction via its configuration).

---

## Phase 1: Project Setup & Core Authentication Backend

**Objective:** Initialize the Next.js application and set up the backend logic for sending and verifying OTPs.

```mermaid
graph TD
    A[Start] --> B{Initialize Next.js Project 'dws-app'};
    B --> C{Install Dependencies: Supabase, TailwindCSS, ShadCN/UI (optional for now)};
    C --> D{Configure Environment Variables (.env.local)};
    D --> E{Initialize Supabase Client};
    E --> G{Create API Route: /api/auth/send-otp};
    G --> H{Implement Supabase OTP Sending Logic via signInWithOtp};
    H --> I{Create API Route: /api/auth/verify-otp};
    I --> J{Implement Supabase OTP Verification Logic via verifyOtp};
    J --> K[Backend Setup Complete];
```

**Steps:**

1.  **Initialize Next.js Project (`dws-app`)**
    *   Action: Use `npx create-next-app@latest dws-app` (with options for TypeScript, Tailwind CSS, App Router).
2.  **Install Dependencies**
    *   Action: `npm install @supabase/supabase-js`
3.  **Configure Environment Variables**
    *   Action: Create `.env.local` in `dws-app` root.
    *   Content:
        ```env
        NEXT_PUBLIC_SUPABASE_URL=https://qebbmojnqzwwdpkhuyyd.supabase.co
        NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY # Obtain from Supabase project settings
        ```
4.  **Initialize Supabase Client**
    *   Action: Create `lib/supabaseClient.ts` (or `.js`).
    *   Content:
        ```typescript
        import { createClient } from '@supabase/supabase-js';

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

        export const supabase = createClient(supabaseUrl, supabaseAnonKey);
        ```
5.  **Create API Route for Sending OTP (`app/api/auth/send-otp/route.ts`)**
    *   Logic:
        *   Accept `phone` number in the request body.
        *   Validate phone number format.
        *   Call `supabase.auth.signInWithOtp({ phone })`.
        *   Return success/failure response.
6.  **Create API Route for Verifying OTP & Logging In (`app/api/auth/verify-otp/route.ts`)**
    *   Logic:
        *   Accept `phone` and `token` (OTP) in the request body.
        *   Call `supabase.auth.verifyOtp({ phone, token, type: 'sms' })`.
        *   If successful, Supabase handles session creation. Return user data and session.
        *   If failed, return an error.

---

## Phase 2: Login Page Frontend

**Objective:** Create the user interface for phone number input and OTP verification, referencing `Prototypes/receipt-login/` for UI/UX.

```mermaid
graph TD
    K[Backend Setup Complete] --> L{Create Login Page: /login};
    L --> M{Implement Phone Input Form (UI from prototype)};
    M --> N{Connect Phone Form to /api/auth/send-otp};
    N --> O{Implement OTP Input Form (UI from prototype)};
    O --> P{Connect OTP Form to /api/auth/verify-otp};
    P --> Q{Manage UI States (loading, error, success)};
    Q --> R{Handle Auth State & Redirection (e.g., to dashboard)};
    R --> S[Login Page Frontend Complete];
```

**Steps:**

1.  **Create Login Page Structure** (`app/login/page.tsx`).
2.  **Implement Phone Number Input Form**.
3.  **Implement OTP Input Form**.
4.  **Connect Frontend to Backend API Routes** (using `fetch` or similar).
5.  **Handle Authentication State & Redirection** (using `supabase.auth.onAuthStateChange`).

---

## Phase 3: Basic Supabase Database Schema (Initial)

**Objective:** Define the initial table structures for `categories` and `receipts` in Supabase. This can be done via Supabase Studio UI or SQL.

**Steps:**

1.  **Define `categories` Table Schema**
    *   Columns: `id` (uuid, pk), `name` (text, not null, unique), `created_at` (timestamptz).
2.  **Define `receipts` Table Schema**
    *   Columns: `id` (uuid, pk), `user_id` (uuid, fk to `auth.users(id)`), `category_id` (uuid, fk to `categories(id)`), `amount` (numeric), `receipt_date` (date), `description` (text), `status` (text), `image_url` (text), `created_at` (timestamptz), `updated_at` (timestamptz).