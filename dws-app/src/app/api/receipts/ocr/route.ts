import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { b } from '@baml/index';
import { Image } from '@boundaryml/baml';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await request.json();
    const { tempFilePath } = body;

    if (!tempFilePath || typeof tempFilePath !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid tempFilePath' }, { status: 400 });
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('receipt-images')
      .download(tempFilePath);

    if (downloadError || !fileData) {
      return NextResponse.json({ error: 'Failed to download image from storage', details: downloadError?.message }, { status: 500 });
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

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

    const image = Image.fromBase64(mediaType, base64);

    const extracted = await b.ExtractReceiptFromImage(image);

    const dateValue = extracted.date.value;
    const isYearValid = extracted.date.checks.valid_year.status === 'succeeded';

    let categoryId: string | null = null;
    if (extracted.category) {
      const { data: categoryMatch } = await supabase
        .from('categories')
        .select('id')
        .ilike('name', extracted.category)
        .single();

      if (categoryMatch) {
        categoryId = categoryMatch.id;
      }
    }

    let isDuplicate = false;
    let existingReceipts: { id: string; description: string }[] = [];

    if (dateValue && extracted.amount !== null && extracted.amount !== undefined) {
      const { data: duplicates, error: dupError } = await supabase
        .from('receipts')
        .select('id, description')
        .eq('user_id', userId)
        .eq('receipt_date', dateValue)
        .eq('amount', extracted.amount);

      if (!dupError && duplicates && duplicates.length > 0) {
        isDuplicate = true;
        existingReceipts = duplicates.map(r => ({
          id: r.id,
          description: r.description || ''
        }));
      }
    }

    const canAutoSubmit = !!(
      dateValue &&
      isYearValid &&
      extracted.amount !== null &&
      extracted.amount !== undefined &&
      categoryId &&
      !isDuplicate
    );

    return NextResponse.json({
      success: true,
      data: {
        date: dateValue || null,
        amount: extracted.amount ?? null,
        category: extracted.category || null,
        category_id: categoryId,
      },
      duplicate: {
        isDuplicate,
        existingReceipts,
      },
      validation: {
        isYearValid,
      },
      canAutoSubmit,
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
