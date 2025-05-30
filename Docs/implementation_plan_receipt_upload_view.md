# Implementation Plan: Receipt Upload and View Functionality

This document outlines the plan for implementing receipt upload and viewing features for employees.

## High-Level Plan:

1.  **Update Documentation:** Reflect the Supabase bucket change in `Docs/PRD.md` (Completed).
2.  **Receipt Upload Functionality:**
    *   **Frontend:** Modify the `ReceiptUploader` component to allow file selection and call a backend API to upload the image to the Supabase `receipt-images` bucket and create a corresponding receipt record in the database.
    *   **Backend:** Implement API endpoints to:
        *   Handle image uploads to the Supabase `receipt-images` bucket.
        *   Create new receipt records in the Supabase database, linking to the uploaded image.
3.  **View Uploaded Receipts Functionality:**
    *   **Frontend:** Modify the `ReceiptTable` component to fetch and display the employee's receipts, including a way to view the image.
    *   **Backend:** Implement an API endpoint to fetch receipts for the authenticated employee, including generating URLs for the stored images.

## Assumptions Made:

1.  **Manual Data Entry:** Date, Amount, Category, Description (if "Other") are entered by the employee via `ReceiptDetailsCard`.
2.  **Initial Receipt Status:** "pending".
3.  **Image Naming/Organization in Supabase Bucket:** `user_id/receipt_id.original_extension`.

## Detailed Plan:

### Phase 1: Update Documentation (Completed)

*   Modified `Docs/PRD.md` to reflect the use of Supabase Storage (`receipt-images` bucket) instead of OneDrive.

### Phase 2: Implement Receipt Upload Functionality

*   **Goal:** Allow employees to select an image, provide necessary details, and have the image uploaded to Supabase Storage and a corresponding receipt record created in the database.

*   **Diagram:**
    ```mermaid
    sequenceDiagram
        participant User as Employee
        participant FE_Uploader as ReceiptUploader.tsx
        participant FE_DetailsCard as ReceiptDetailsCard.tsx
        participant BE_UploadAPI as /api/receipts/upload/route.ts
        participant SupabaseStorage as Supabase Storage (receipt-images)
        participant BE_ReceiptsAPI as /api/receipts/route.ts
        participant SupabaseDB as Supabase DB (receipts table)

        User->>FE_Uploader: Selects image file
        FE_Uploader->>FE_Uploader: Sets `uploadedFile` state
        FE_Uploader->>FE_DetailsCard: Shows dialog with initialData (empty for Date, Amount)
        User->>FE_DetailsCard: Enters Date, Amount, Category, Notes
        FE_DetailsCard->>FE_Uploader: Submits form data (`handleDetailsSubmit`)
        
        FE_Uploader->>BE_UploadAPI: POST request (multipart/form-data: file)
        Note over BE_UploadAPI, SupabaseStorage: Get authenticated user_id from session
        BE_UploadAPI->>SupabaseStorage: Upload file to `user_id/temp_randomstring_originalfilename.ext`
        SupabaseStorage-->>BE_UploadAPI: Upload success (returns tempFilePath: "user_id/temp_randomstring_originalfilename.ext")
        BE_UploadAPI-->>FE_Uploader: Returns { success: true, tempFilePath: "..." }
        
        FE_Uploader->>BE_ReceiptsAPI: POST request (receiptData from form, tempFilePath, user_id)
        Note over BE_ReceiptsAPI, SupabaseDB: Get authenticated user_id from session
        BE_ReceiptsAPI->>SupabaseDB: Insert new receipt (date, amount, category_id, notes, status: 'pending', image_url: tempFilePath, user_id)
        SupabaseDB-->>BE_ReceiptsAPI: Returns new receipt record (with generated ID: NEW_RECEIPT_ID)
        
        Note over BE_ReceiptsAPI, SupabaseStorage: Construct final image path: `user_id/NEW_RECEIPT_ID.original_extension`
        BE_ReceiptsAPI->>SupabaseStorage: Move/Rename file from tempFilePath to final image path
        SupabaseStorage-->>BE_ReceiptsAPI: Rename success
        
        BE_ReceiptsAPI->>SupabaseDB: Update receipt record's `image_url` with final image path (or public URL if generated)
        SupabaseDB-->>BE_ReceiptsAPI: Update success
        
        BE_ReceiptsAPI-->>FE_Uploader: Returns { success: true, receipt: newReceiptWithFinalImageUrl }

        FE_Uploader->>FE_Uploader: Calls `onReceiptAdded(newReceiptWithFinalImageUrl)`
        FE_Uploader->>User: Shows success toast
    end
    ```

*   **Steps:**

    1.  **Create Backend API for Image Upload (`dws-app/src/app/api/receipts/upload/route.ts`):**
        *   Accepts `POST` requests with `multipart/form-data` (the image file).
        *   Authenticates the user (gets `user_id` from Supabase session).
        *   Uploads the image to Supabase Storage in the `receipt-images` bucket.
            *   Initial temporary path: `user_id/temp_randomstring_originalfilename.ext`.
        *   Returns the temporary path of the uploaded file.
    2.  **Create Backend API for Receipt Creation (`dws-app/src/app/api/receipts/route.ts` - POST method):**
        *   Accepts `POST` requests with JSON data: `date`, `amount`, `category_id`, `notes`, and `tempFilePath` (from the upload API).
        *   Authenticates the user (gets `user_id`).
        *   Inserts a new record into the `receipts` table in Supabase with `status: "pending"` and initial `image_url` as `tempFilePath`.
        *   Retrieves the `id` (NEW_RECEIPT_ID) of the newly created receipt.
        *   Constructs the final image path: `user_id/NEW_RECEIPT_ID.original_extension`.
        *   Renames/moves the image in Supabase Storage from `tempFilePath` to the final image path.
        *   Updates the `image_url` in the `receipts` table to the final image path (or a generated public URL).
        *   Returns the newly created and updated receipt object.
    3.  **Modify Frontend `ReceiptUploader` Component (`dws-app/src/components/receipt-uploader.tsx`):**
        *   In `handleDetailsSubmit`:
            *   Call the `/api/receipts/upload` endpoint with the `uploadedFile`.
            *   On success, take the returned `tempFilePath` and the form data (`receiptData`).
            *   Call the `/api/receipts` (POST) endpoint with this data.
            *   Update `onReceiptAdded` to use the actual receipt object returned from the backend.
            *   Implement loading states and error handling for both API calls.
    4.  **Modify `Receipt` type in `dws-app/src/lib/types.ts`:**
        *   Update comment for `image_url` to reflect Supabase Storage path/URL.

### Phase 3: Implement View Uploaded Receipts Functionality

*   **Goal:** Allow employees to see a list of their submitted receipts, with links to view the images.

*   **Diagram:**
    ```mermaid
    sequenceDiagram
        participant User as Employee
        participant FE_EmployeePage as employee/page.tsx
        participant FE_ReceiptTable as ReceiptTable.tsx
        participant BE_ReceiptsAPI as /api/receipts/route.ts
        participant SupabaseDB as Supabase DB (receipts table)
        participant SupabaseStorage as Supabase Storage (receipt-images)

        User->>FE_EmployeePage: Navigates to employee page
        FE_EmployeePage->>BE_ReceiptsAPI: GET request (to fetch user's receipts)
        Note over BE_ReceiptsAPI, SupabaseDB: Get authenticated user_id from session
        BE_ReceiptsAPI->>SupabaseDB: Query receipts table for user_id
        SupabaseDB-->>BE_ReceiptsAPI: Returns list of receipt records
        
        loop for each receipt
            BE_ReceiptsAPI->>SupabaseStorage: Get public URL for receipt.image_url (which is a path like `user_id/receipt_id.ext`)
            SupabaseStorage-->>BE_ReceiptsAPI: Returns public URL
            Note over BE_ReceiptsAPI: Augment receipt object by replacing image_url path with its public URL
        end
        BE_ReceiptsAPI-->>FE_EmployeePage: Returns list of receipts (with public image_url)
        
        FE_EmployeePage->>FE_ReceiptTable: Passes receipts data
        FE_ReceiptTable->>User: Displays receipts in table
        User->>FE_ReceiptTable: Clicks "View" link for a receipt
        FE_ReceiptTable->>SupabaseStorage: Opens public image_url in new tab
    end
    ```

*   **Steps:**

    1.  **Modify Backend API for Fetching Receipts (`dws-app/src/app/api/receipts/route.ts` - GET method):**
        *   Accepts `GET` requests.
        *   Authenticates the user (gets `user_id`).
        *   Fetches all receipts from the `receipts` table for the authenticated `user_id`.
        *   For each receipt, generate a publicly accessible URL (e.g., signed URL or public URL if bucket policy allows) for the `image_url` path using Supabase Storage API.
        *   Replace the `image_url` path in the receipt object with this viewable public URL.
        *   Returns the list of receipt objects.
    2.  **Modify Frontend Employee Page (`dws-app/src/app/employee/page.tsx`):**
        *   On page load, fetch receipts for the current user by calling the `/api/receipts` (GET) endpoint.
        *   Pass the fetched receipts (which now contain public image URLs) to the `ReceiptTable` component.
        *   Handle loading and error states.
    3.  **Modify Frontend `ReceiptTable` Component (`dws-app/src/components/receipt-table.tsx`):**
        *   The component should already work correctly if `receipt.image_url` now contains a direct public URL.