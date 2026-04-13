import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();

  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError) {
    return NextResponse.json({ error: 'Failed to authenticate user' }, { status: 500 });
  }

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = user.id;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type.' }, { status: 400 });
    }

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'File exceeds 10MB limit.' }, { status: 400 });
    }

    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    const randomString = uuidv4().slice(0, 8);
    const processedFileExtension = (file.type !== 'application/pdf' && fileExtension !== 'pdf') ? 'jpg' : fileExtension;
    const tempFileName = `${userId}/temp_${randomString}_${Date.now()}.${processedFileExtension}`;
    const bucketName = 'receipt-images';

    let fileBuffer: Buffer;
    let processedContentType = file.type;

    if (file.type.startsWith('image/') && file.type !== 'application/pdf') {
      try {
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
      } catch (sharpError) {
        console.error('POST /api/receipts/upload: Sharp image processing error:', sharpError);
        // Fallback: Try to upload the original file if sharp fails
        fileBuffer = Buffer.from(await file.arrayBuffer());
        processedContentType = file.type;
      }
    } else {
      fileBuffer = Buffer.from(await file.arrayBuffer());
    }

    const { data, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(tempFileName, fileBuffer, {
        contentType: processedContentType,
        upsert: false
      });

    if (uploadError) {
      return NextResponse.json({ error: `Failed to upload file: ${uploadError.message}` }, { status: 500 });
    }

    if (!data || !data.path) {
        return NextResponse.json({ error: 'Failed to upload file: No path returned from storage.' }, { status: 500 });
    }
    return NextResponse.json({ success: true, tempFilePath: data.path }, { status: 200 });

  } catch (error) {
    console.error('POST /api/receipts/upload: Unhandled error in try-catch block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
