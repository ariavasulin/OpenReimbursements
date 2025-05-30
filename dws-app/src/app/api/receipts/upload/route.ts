import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient'; // Changed import
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: Request) {
  console.log("POST /api/receipts/upload: Handler called");
  const supabase = await createSupabaseServerClient();

  // Use getUser() for a more secure way to get the authenticated user server-side
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError) {
    console.error("POST /api/receipts/upload: Error getting user:", userError);
    return NextResponse.json({ error: 'Failed to authenticate user' }, { status: 500 });
  }
  
  if (!user) {
    console.log("POST /api/receipts/upload: No user, unauthorized");
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = user.id;
  console.log("POST /api/receipts/upload: Authenticated user ID:", userId);

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      console.log("POST /api/receipts/upload: No file provided in formData");
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    console.log(`POST /api/receipts/upload: File received: ${file.name}, type: ${file.type}, size: ${file.size}`);

    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      console.log(`POST /api/receipts/upload: Invalid file type: ${file.type}`);
      return NextResponse.json({ error: 'Invalid file type.' }, { status: 400 });
    }

    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      console.log(`POST /api/receipts/upload: File size ${file.size} exceeds ${maxSize} limit.`);
      return NextResponse.json({ error: 'File exceeds 10MB limit.' }, { status: 400 });
    }

    const fileExtension = file.name.split('.').pop();
    const randomString = uuidv4().slice(0, 8);
    const tempFileName = `${userId}/temp_${randomString}_${Date.now()}.${fileExtension}`;
    const bucketName = 'receipt-images';
    console.log(`POST /api/receipts/upload: Attempting to upload to bucket '${bucketName}' with path '${tempFileName}'`);

    const { data, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(tempFileName, file);

    if (uploadError) {
      console.error('POST /api/receipts/upload: Supabase storage upload error:', uploadError);
      // This is where the RLS error message is likely coming from
      return NextResponse.json({ error: `Failed to upload file: ${uploadError.message}` }, { status: 500 });
    }

    if (!data || !data.path) {
        console.error('POST /api/receipts/upload: Supabase storage upload error: No path returned in data.');
        return NextResponse.json({ error: 'Failed to upload file: No path returned from storage.' }, { status: 500 });
    }
    console.log("POST /api/receipts/upload: File upload successful. Path:", data.path);
    return NextResponse.json({ success: true, tempFilePath: data.path }, { status: 200 });

  } catch (error) {
    console.error('POST /api/receipts/upload: Unhandled error in try-catch block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}