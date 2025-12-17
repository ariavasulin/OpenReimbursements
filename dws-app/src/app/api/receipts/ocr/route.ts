import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { b } from '@baml/index';
import { Image } from '@boundaryml/baml';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session) {
      console.error('OCR API: Unauthorized - Session error or no session', sessionError);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { tempFilePath } = body;

    if (!tempFilePath || typeof tempFilePath !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid tempFilePath' }, { status: 400 });
    }

    // Download image from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('receipt-images')
      .download(tempFilePath);

    if (downloadError || !fileData) {
      console.error(`OCR API: Error downloading file from Supabase Storage: ${tempFilePath}`, downloadError);
      return NextResponse.json({ error: 'Failed to download image from storage', details: downloadError?.message }, { status: 500 });
    }

    // Convert to base64 for BAML
    const arrayBuffer = await fileData.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Determine media type from file extension
    const extension = tempFilePath.split('.').pop()?.toLowerCase() || 'jpeg';
    const mediaTypeMap: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'webp': 'image/webp',
      'heic': 'image/heic',
      'heif': 'image/heif',
      'pdf': 'application/pdf',
    };
    const mediaType = mediaTypeMap[extension] || 'image/jpeg';

    // Create BAML Image from base64
    const image = Image.fromBase64(mediaType, base64);

    // Call BAML extraction function
    console.log('OCR API: Calling BAML ExtractReceiptFromImage...');
    const extracted = await b.ExtractReceiptFromImage(image);
    console.log('OCR API: BAML extraction result:', extracted);

    // Return extracted data in the expected format
    return NextResponse.json({
      success: true,
      data: {
        date: extracted.date || null,
        amount: extracted.amount || null,
      },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('OCR API: Unexpected error:', error);
    return NextResponse.json({
      error: 'Internal server error',
      details: errorMessage
    }, { status: 500 });
  }
}
