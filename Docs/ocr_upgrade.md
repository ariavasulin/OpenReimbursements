# OCR Performance Upgrade Plan

This document outlines the plan to improve the performance and user experience of the receipt OCR functionality by introducing server-side image preprocessing.

## 1. Problem Analysis

Based on production logs (`logs_result.json`), the current receipt upload and OCR process exhibits the following characteristics:

- **Large File Sizes**: Users are uploading images directly from their mobile devices, resulting in file sizes of 2.5MB to over 4MB.
- **High OCR Latency**: The `/api/receipts/ocr` endpoint takes **3-4 seconds** to execute. A significant portion of this time is spent downloading the large, temporary image file from Supabase Storage to the Vercel serverless function before it can be sent to the Google Vision API.
- **Bottleneck**: The primary performance bottleneck is the transfer and processing of large image files, not the OCR text extraction logic itself.

## 2. Goal

The primary goal is to **significantly reduce the end-to-end time** from the moment a user selects a receipt image to when the OCR results are displayed. This will be achieved by decreasing the size of the image that needs to be stored, transferred, and processed.

## 3. Proposed Solution: Server-Side Image Preprocessing

We will introduce an image preprocessing step within the initial file upload API route (`/api/receipts/upload/route.ts`) using the `sharp` library.

### 3.1. Detailed Implementation Plan

#### Step 1: Install Dependencies
1.  Add the `sharp` library to the project's dependencies.
    ```bash
    cd dws-app
    npm install sharp
    ```

#### Step 2: Modify the Upload API (`/api/receipts/upload/route.ts`)
The core logic change will happen in this file. The new workflow will be:

1.  **Receive File**: The `POST` handler continues to accept the `multipart/form-data` upload.
2.  **Initial Validation**: The existing validation for file existence, user authentication, original file size (e.g., < 10MB), and file type (images, PDF) will be maintained.
3.  **Check File Type**:
    - If the file is an **image** (`image/jpeg`, `image/png`, etc.), proceed to the preprocessing step.
    - If the file is a **PDF** (`application/pdf`), bypass preprocessing and proceed directly to the upload step.
4.  **Image Preprocessing (Using `sharp`)**:
    - Convert the incoming image file into a `Buffer`.
    - Use `sharp` to perform the following operations:
        - **Resize**: Constrain the image dimensions to a maximum of **1200x1200 pixels** while preserving the aspect ratio (`fit: 'inside'`). This prevents enlarging images that are already small.
        - **Compress & Convert**: Convert the output image to JPEG format with a quality setting of **80%** and enable progressive rendering for a better perceived loading experience. This standardizes the format and significantly reduces file size.
    - The output of this step is a new, optimized `Buffer`.
5.  **Upload to Supabase**:
    - Upload the **processed buffer** (for images) or the **original buffer** (for PDFs) to Supabase Storage.
    - Explicitly set the `contentType` for the uploaded file (`image/jpeg` for processed images, original type for PDFs).
    - The temporary file path will be generated as before (e.g., `user_id/temp_...`). For consistency, processed images will use a `.jpg` extension.

#### Step 3: Error Handling
- The `sharp` processing logic will be wrapped in a `try...catch` block.
- **On Failure**: If `sharp` fails to process an image, the system will log a warning and fall back to uploading the original, unprocessed image file. This ensures the upload process does not fail completely due to a processing error.

### 3.2. Code Implementation Snippet

```typescript
// dws-app/src/app/api/receipts/upload/route.ts

import sharp from 'sharp';

// ... inside the POST handler ...

const file = formData.get('file') as File;

// ... after initial validations ...

let fileBuffer: Buffer;
let processedContentType = file.type;
const fileExtension = file.name.split('.').pop()?.toLowerCase();
const processedFileExtension = (file.type.startsWith('image/')) ? 'jpg' : fileExtension;
const tempFileName = `${userId}/temp_${uuidv4().slice(0,8)}_${Date.now()}.${processedFileExtension}`;

if (file.type.startsWith('image/')) {
  try {
    console.log(`Processing image ${file.name} with sharp.`);
    const originalBuffer = Buffer.from(await file.arrayBuffer());
    fileBuffer = await sharp(originalBuffer)
      .resize({
        width: 1200,
        height: 1200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();
    processedContentType = 'image/jpeg';
    console.log(`Image processed. New size: ${fileBuffer.length} bytes`);
  } catch (sharpError) {
    console.error('Sharp image processing error:', sharpError);
    console.warn('Sharp failed. Attempting to upload original file.');
    fileBuffer = Buffer.from(await file.arrayBuffer()); // Fallback
  }
} else {
  // For PDFs, just get the buffer
  fileBuffer = Buffer.from(await file.arrayBuffer());
}

// Upload the fileBuffer to Supabase Storage
const { data, error } = await supabase.storage
  .from('receipt-images')
  .upload(tempFileName, fileBuffer, {
    contentType: processedContentType,
    upsert: false
  });

// ... rest of the handler
```

## 4. Expected Outcomes & Benefits

- **Faster OCR**: The `/api/receipts/ocr` function will download a much smaller file, drastically reducing its execution time.
- **Improved User Experience**: The user will see OCR results much faster, making the app feel more responsive.
- **Reduced Storage Costs**: Storing smaller, optimized images in Supabase Storage will lead to cost savings over time.
- **Reduced Bandwidth Usage**: Less data will be transferred between the client, the Vercel functions, and Supabase.

## 5. Potential Risks & Mitigation

- **`sharp` on Vercel**: `sharp` has native dependencies.
  - **Mitigation**: Vercel's build environment is generally well-equipped to handle `sharp`. We will confirm this during testing. If issues arise, we may need to consult Vercel's documentation for specific configuration.
- **Processing Failure**: `sharp` could fail on a malformed or unsupported image file.
  - **Mitigation**: The implemented fallback mechanism ensures that if processing fails, the original file is uploaded, preventing a hard failure for the user.
- **PDF Handling**: The logic must correctly bypass image processing for PDFs.
  - **Mitigation**: The code explicitly checks `file.type` to differentiate between images and other file types like PDFs. This has been included in the implementation plan.

## 6. Testing Plan

1.  **Unit/Integration Testing**:
    - Test the `/api/receipts/upload` endpoint with various image types (JPEG, PNG).
    - Verify that uploaded images in Supabase Storage are resized and have smaller file sizes.
    - Test with PDF files and confirm they are uploaded without modification.
    - Test with very small images to ensure they are not enlarged.
2.  **End-to-End Testing**:
    - Perform a full receipt upload flow in a staging/preview environment.
    - Measure the time from file selection to OCR result display and compare it against the current production baseline.
    - Verify that OCR accuracy is not negatively impacted by the resizing and compression.
3.  **Load Testing (Optional)**:
    - Simulate multiple concurrent uploads to ensure the serverless function handles the processing load.
4.  **Log Verification**:
    - Check production logs after deployment to confirm the new logic is working as expected and to monitor for any `sharp`-related errors. 