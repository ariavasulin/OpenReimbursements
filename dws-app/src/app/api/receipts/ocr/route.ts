import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { ImageAnnotatorClient } from '@google-cloud/vision';

let visionClient: ImageAnnotatorClient;
let visionClientError: Error | null = null;

try {
  const credentialsJsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJsonString) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set or empty.');
  }
  const credentials = JSON.parse(credentialsJsonString);
  visionClient = new ImageAnnotatorClient({ credentials });
  console.log('OCR API: Google Vision Client initialized with explicit credentials.');
} catch (e: any) {
  visionClientError = e;
  console.error('OCR API: FATAL - Failed to initialize Google Vision Client:', e.message);
  // If visionClient is not initialized, the POST handler will catch this
}

export async function POST(request: NextRequest) {
  if (visionClientError || !visionClient) {
    console.error('OCR API: Vision client not initialized. Cannot process request.', visionClientError);
    return NextResponse.json({ error: 'OCR service initialization failed.', details: visionClientError?.message }, { status: 500 });
  }

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

    // 1. Fetch image from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('receipt-images') // As per .cursorrules line 85
      .download(tempFilePath);

    if (downloadError || !fileData) {
      console.error(`OCR API: Error downloading file from Supabase Storage: ${tempFilePath}`, downloadError);
      return NextResponse.json({ error: 'Failed to download image from storage', details: downloadError?.message }, { status: 500 });
    }

    const imageBytes = Buffer.from(await fileData.arrayBuffer());

    // 2. Send image to Google Cloud Vision API
    const [result] = await visionClient.textDetection(imageBytes);
    const detections = result.textAnnotations;

    let extractedDate: string | null = null;
    let extractedAmount: number | null = null;

    if (detections && detections.length > 0) {
      const fullText = detections[0].description || "";
      console.log("OCR API: Full detected text:\n", fullText); // Log the full text

      // Basic Date Extraction
      const dateRegex = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{2,4})|(\d{1,2}\.\d{1,2}\.\d{2,4})|((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s\d{1,2}(?:st|nd|rd|th)?(?:,)?\s\d{2,4})/i;
      const dateMatch = fullText.match(dateRegex);
      let rawExtractedDate: string | null = null;
      if (dateMatch) {
        // The first element (index 0) is the full match. Subsequent elements are the captured groups.
        // We want the first non-null captured group.
        rawExtractedDate = dateMatch.slice(1).find(group => group != null) || null;
        console.log("OCR API: Raw extracted date string:", rawExtractedDate);
        if (rawExtractedDate) {
            try {
                // Attempt to parse and reformat to YYYY-MM-DD
                const parsedDate = new Date(rawExtractedDate.replace(/\./g, '/').replace(/(\d+)(st|nd|rd|th)/, '$1'));
                if (!isNaN(parsedDate.getTime())) {
                    extractedDate = parsedDate.toISOString().split('T')[0];
                    console.log("OCR API: Parsed and formatted date:", extractedDate);
                } else {
                    console.warn("OCR API: Extracted date string resulted in an invalid date:", rawExtractedDate);
                    extractedDate = null; // Invalid date
                }
            } catch (e) {
                console.warn("OCR API: Could not parse extracted date string:", rawExtractedDate, e);
                extractedDate = null;
            }
        } else {
          console.log("OCR API: No date string matched regex.");
        }
      } else {
        console.log("OCR API: dateRegex found no matches in full text.");
      }


      // Basic Amount Extraction
      const amountRegex = /(?:total|amount|balance|charge|due|summe|gesamtbetrag)\s*(?:is|was|:)?\s*(?:[\$€£¥]?\s*)?(\d+(?:[.,]\d{1,2})?)/gi; // Added 'g' flag for multiple matches
      let amountMatchesIterator = fullText.matchAll(amountRegex);
      let potentialAmounts: number[] = [];
      for (const match of amountMatchesIterator) {
        if (match[1]) {
            const currentAmountStr = match[1].replace(',', '.');
            const currentAmount = parseFloat(currentAmountStr);
            if (!isNaN(currentAmount)) {
                potentialAmounts.push(currentAmount);
            }
        }
      }
      
      if (potentialAmounts.length > 0) {
        // Often the largest amount is the total.
        extractedAmount = Math.max(...potentialAmounts);
      }
    }

    console.log("OCR API: Returning data to client:", { date: extractedDate, amount: extractedAmount });
    return NextResponse.json({
      success: true,
      data: {
        date: extractedDate,
        amount: extractedAmount,
      },
    });

  } catch (error: any) {
    console.error('OCR API: Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 });
  }
}